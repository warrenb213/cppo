import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { claudeShellArgs } from './cli';
import { decideStop, readTranscriptTail, sessionTasks } from './handoff';
import { log } from './log';
import { TASK_LIMITS, type AgentTasks } from './agentTasks';
import { UsageBook, zaiQuota, fromRateLimitInfo, claudeCodeUsage } from './usage';
import { callCodexWorker, CodexContext, codexUsage } from './codex';
import { candidates, CATALOG, clampEffort, Effort, effectivePolicy, roleDef, RolePolicy, Skip, THINKING_BUDGET, worthFallingBack } from './roles';

/**
 * Workers: other models the window's AI can consult — "Claude leads, others help".
 *
 * A small MCP server inside the extension host, on 127.0.0.1 behind a random
 * token. Claude Code connects to it like any MCP server and gets two tools:
 * `list_workers` and `delegate`. A worker only answers: one request with the
 * task and the context the lead chose to send, nothing else — it can't read
 * files or run anything. Provider keys never leave VS Code's secret storage:
 * the server asks for a key per call.
 *
 * Why here and not in the session: a Claude Code session has one endpoint and
 * one credential. Consulting another provider from a session on the Anthropic
 * login would otherwise mean proxying that login — which this never does.
 *
 * Registered in the window's own CLAUDE_CONFIG_DIR/.claude.json (user-scope
 * mcpServers) only while at least one worker is enabled; removed otherwise and
 * when the window closes. New Claude Code sessions pick it up.
 */

export interface Worker {
  /** Stable handle the lead passes to `delegate`, e.g. "zai/glm-5.3". */
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  baseUrl: string;
  auth: 'bearer' | 'x-api-key';
  /** One line for the lead: what this worker is good for. */
  note: string;
  /** Also enabled for agent tasks (agentTasks.ts): runs in a worktree with tools. */
  agent?: boolean;
  /**
   * 'login': Claude on the window's own Anthropic login — run as headless Claude
   * Code on the account's directory (callLoginWorker), never with its token here.
   * 'codex': GPT through the Codex CLI (codex.ts), on a ChatGPT plan or an API key.
   */
  kind?: 'login' | 'codex';
  /** The provider's preset, for usage lookups (e.g. 'zai'). */
  preset?: string;
  /** On a subscription (the Anthropic login, a Coding Plan, a ChatGPT plan) rather than billed per token. */
  plan?: boolean;
  /** Codex: the reasoning efforts the model takes. */
  efforts?: string[];
  /** Codex: the account can generate images (2D art). */
  images?: boolean;
}

export interface WorkerSource {
  workers(): Worker[];
  keyFor(providerId: string): Promise<string | undefined>;
  /** The account's own Claude Code directory (its store — never a window's working dir, which may carry a gateway). */
  loginDir(): string | undefined;
  /** How to run Codex for a Codex provider; undefined when it can't (no binary, no key). */
  codexContext(providerId: string): Promise<CodexContext | undefined>;
  /** The roles the user set (orchestration panel); undefined = the template. */
  rolePolicy(): RolePolicy | undefined;
  /** This account's Claude Code directories and email — where Claude Code caches its plan usage. */
  claudeUsageDirs(): { dirs: string[]; email?: string };
  readonly onDidChange: vscode.EventEmitter<void>;
}

export const LOGIN_PROVIDER = 'Anthropic login';

const SERVER_NAME = 'cppo';
/** What Claude Parallel Accounts (CPPO's old name) registered — removed where found. */
const LEGACY_SERVER_NAME = 'claude-accounts-workers';
/** Caps per call — a worker is for focused questions, not for shipping the repo. */
const MAX_CONTEXT_CHARS = 120_000;
const MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_OUTPUT_TOKENS = 4_096;
/** Per window session (extension host lifetime). */
const MAX_CALLS = 100;
/**
 * Claude Code waits 60 s for an MCP call unless the server entry sets
 * `timeout`, and drops an HTTP MCP call that stays silent for 5 minutes
 * (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT). This server answers each call in one
 * piece, so every call must finish inside that: the entry asks for just under
 * 5 minutes, and calls give up before it.
 */
export const MCP_CALL_TIMEOUT_MS = 295_000;
const CALL_TIMEOUT_MS = 270_000;

const WORKER_SYSTEM =
  'You are a worker model consulted by another AI assistant (the lead), which is helping a user with ' +
  'software work. You only see what the lead sent you: answer the task with that, precisely and ' +
  'concisely. If the material is insufficient, say exactly what is missing instead of guessing. ' +
  'Your answer goes back to the lead, which will check it before relying on it.';

type Json = Record<string, unknown>;

/**
 * Room for reasoning on top of the answer cap. Models such as GLM think by
 * default and their thinking counts against max_tokens: with a 400-token cap,
 * GLM-5.3-Flash spent all 400 thinking and wrote no answer.
 */
const THINKING_HEADROOM = 8_192;

/** The worker call itself: an Anthropic Messages request to the worker's provider. */
export async function callWorker(
  w: Worker,
  key: string,
  task: string,
  context: string | undefined,
  maxTokens: number,
  effort?: Effort
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number }> {
  const url = `${w.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (w.auth === 'x-api-key') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  const content = context ? `${task}\n\n<context>\n${context}\n</context>` : task;
  const started = Date.now();
  type Reply = {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  const send = async (extra: Record<string, unknown>): Promise<Reply> => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: w.model, system: WORKER_SYSTEM, messages: [{ role: 'user', content }], ...extra }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS - (Date.now() - started)),
    });
    const body = (await res.json().catch(() => ({}))) as Reply;
    if (!res.ok) throw new Error(`${w.providerName} answered HTTP ${res.status}: ${body.error?.message ?? 'no details'}`);
    return body;
  };
  const textOf = (b: Reply) =>
    (b.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
  // Effort, on the Messages API, is the thinking budget; unset, the model's own default (GLM thinks).
  const budget = effort ? THINKING_BUDGET[effort] : undefined;
  let body = await send(
    budget === undefined
      ? { max_tokens: maxTokens + THINKING_HEADROOM }
      : budget === 0
        ? { max_tokens: maxTokens, thinking: { type: 'disabled' } }
        : { max_tokens: maxTokens + budget, thinking: { type: 'enabled', budget_tokens: budget } }
  );
  let inTok = body.usage?.input_tokens ?? 0;
  let outTok = body.usage?.output_tokens ?? 0;
  if (!textOf(body) && body.stop_reason === 'max_tokens') {
    // It thought through the whole budget: ask again for a direct answer.
    body = await send({ max_tokens: maxTokens, thinking: { type: 'disabled' } });
    inTok += body.usage?.input_tokens ?? 0;
    outTok += body.usage?.output_tokens ?? 0;
  }
  return { text: textOf(body), inputTokens: inTok, outputTokens: outTok, ms: Date.now() - started };
}

/**
 * A worker on the Anthropic login: Claude Code itself, headless, on the
 * account's own directory — no tools, no MCP servers, the worker's system
 * prompt. The subscription is only ever used by Claude Code. Its stream also
 * carries the subscription's rate-limit windows (rate_limit_event), returned
 * for the usage book.
 */
export function callLoginWorker(
  w: Worker,
  accountDir: string,
  task: string,
  context: string | undefined,
  effort?: Effort
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number; rateLimit?: Record<string, unknown> }> {
  const content = context ? `${task}\n\n<context>\n${context}\n</context>` : task;
  const args = [
    '-p', content, '--model', w.model, '--system-prompt', WORKER_SYSTEM, '--tools', '',
    ...(effort ? ['--effort', effort] : []),
    '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    // Belt and braces: the official endpoint and no provider key, whatever settings are around.
    '--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } }),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];
  env.CLAUDE_CONFIG_DIR = accountDir;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/bash', claudeShellArgs(args), {
      cwd: accountDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let err = '';
    let text = '';
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    let rateLimit: Record<string, unknown> | undefined;
    let failed: string | undefined;
    const timer = setTimeout(() => child.kill('SIGKILL'), CALL_TIMEOUT_MS);
    const onLine = (line: string) => {
      try {
        const ev = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean; usage?: typeof usage; rate_limit_info?: Record<string, unknown> };
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info) rateLimit = ev.rate_limit_info;
        if (ev.type === 'result') {
          text = ev.result ?? '';
          usage = ev.usage;
          if (ev.is_error) failed = ev.result || 'the run ended with an error';
        }
      } catch {
        /* not JSON */
      }
    };
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      if (failed || (code !== 0 && !text)) {
        reject(new Error(failed ?? (err.trim().split('\n').slice(-2).join(' ') || `claude exited with ${code}`)));
      } else {
        resolve({ text: text.trim(), inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, ms: Date.now() - started, rateLimit });
      }
    });
  });
}

/** One `delegate` call, kept for its transcript (the account hover links to them). */
export interface Consult {
  n: number;
  worker: string;
  caller: 'lead' | 'agent';
  at: number;
  task: string;
  context?: string;
  answer?: string;
  error?: string;
  ms?: number;
  inTok?: number;
  outTok?: number;
  /** Asked for by role (roles.ts), and the effort it ran at. */
  role?: string;
  effort?: string;
}

const KEEP_CONSULTS = 50;

export class DelegateServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;
  /** The lead's token: every tool. */
  private readonly token = crypto.randomBytes(24).toString('hex');
  /** Agent runs' token: consult and usage only — a worker can't start tasks. */
  private readonly workerToken = crypto.randomBytes(24).toString('hex');
  private calls = 0;
  private readonly stopBlocks = new Map<string, number>();
  readonly usage = new UsageBook();
  /** This window's latest consultations, oldest first. */
  readonly consults: Consult[] = [];
  readonly onDidConsult = new vscode.EventEmitter<Consult>();
  /** Open GET event streams (sessions listening for server notifications). */
  private readonly streams = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;
  /** The tool lists last announced, to notify only on a real change. */
  private lastTools = '';
  private readonly subscription: vscode.Disposable;

  /** `configDir`: this window's CLAUDE_CONFIG_DIR (its own working dir), or undefined when unbound. */
  constructor(
    private readonly source: WorkerSource,
    private readonly configDir: () => string | undefined,
    private readonly agents?: AgentTasks
  ) {
    this.subscription = source.onDidChange.event(() => void this.reconcile());
  }

  /** Server up and registered while any worker is enabled; down and unregistered otherwise. */
  async reconcile(): Promise<void> {
    const dir = this.configDir();
    const want = Boolean(dir) && this.source.workers().length > 0;
    try {
      if (want) {
        const wasUp = Boolean(this.server);
        await this.start();
        if (wasUp) this.notifyToolsChanged();
        register(dir!, {
          type: 'http',
          url: `http://127.0.0.1:${this.port}/mcp`,
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: MCP_CALL_TIMEOUT_MS,
        });
        registerStopHook(dir!, Boolean(this.agents) && this.source.workers().some((w) => w.agent));
      } else {
        if (dir) {
          registerStopHook(dir, false);
          register(dir, undefined);
        }
        this.stop();
      }
    } catch (err) {
      log(`workers: ${(err as Error).message}`);
    }
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        this.lastTools = JSON.stringify([this.tools(true), this.tools(false)]);
        log(`workers: MCP server on 127.0.0.1:${this.port} (${this.source.workers().map((w) => w.id).join(', ')})`);
        resolve();
      });
    });
  }

  private stop(): void {
    for (const s of this.streams) s.end();
    this.streams.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.server?.close();
    this.server = undefined;
  }

  /**
   * Tells listening sessions their tool list changed (workers enabled or
   * removed, agent tasks switched on), so open Claude Code sessions re-read it
   * instead of keeping the list they started with.
   */
  private notifyToolsChanged(): void {
    const now = JSON.stringify([this.tools(true), this.tools(false)]);
    if (now === this.lastTools) return;
    this.lastTools = now;
    const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
    for (const s of this.streams) s.write(event);
    if (this.streams.size) log(`workers: told ${this.streams.size} session(s) the tools changed`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: Json) => {
      res.writeHead(status, body ? { 'content-type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const lead = req.headers.authorization === `Bearer ${this.token}`;
    if (!lead && req.headers.authorization !== `Bearer ${this.workerToken}`) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/event-stream')) {
      // A session listening for notifications (tools/list_changed).
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': listening\n\n');
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
      // Comments keep idle connections from being dropped; clients ignore them.
      this.heartbeat ??= setInterval(() => this.streams.forEach((s) => s.write(': ping\n\n')), 25_000);
      return;
    }
    if (req.method === 'DELETE') return send(200);
    if (req.method !== 'POST') return send(405);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_CONTEXT_CHARS * 4) return send(413, { error: 'request too large' });
    }
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined) return send(202); // a notification (initialized, cancelled…)
    const reply = (result: Json) => send(200, { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => send(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: '1' },
          instructions:
            'Other AI models (workers) the user enabled. `delegate` asks one a question (answers only). ' +
            'Where enabled, start_task runs one as an agent on a scratch worktree of the repo and returns a ' +
            'diff via wait_task; review it before apply_task_changes. Ask by `role` (list_roles: quick, ' +
            'second-opinion, review, hard-reasoning, implement, test-and-fix, vector-art, 2d-art) so the user\'s ' +
            'choice of model, effort and fallbacks applies. Check workers\' output before relying on it. ' +
            "After start_task, keep working: call wait_task (it waits up to 4 minutes) until every task you started is done, then review each diff and apply or report it; don't end your turn while tasks you started are still running.",
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.tools(lead) });
      case 'tools/call': {
        const name = String(msg.params?.name);
        if (!this.tools(lead).some((t) => t.name === name)) return reply({ content: [{ type: 'text', text: `Tool ${name} is not available here.` }], isError: true });
        return reply(await this.call(name, (msg.params?.arguments ?? {}) as Json, lead ? 'lead' : 'agent'));
      }
      default:
        return fail(-32601, `unknown method ${msg.method}`);
    }
  }

  /** Where agent runs reach this server, with the restricted token — while it is running. */
  workerAccess(): { url: string; token: string } | undefined {
    return this.server ? { url: `http://127.0.0.1:${this.port}/mcp`, token: this.workerToken } : undefined;
  }

  private tools(lead = true): Json[] {
    const ids = this.source.workers().map((w) => w.id);
    const all: Json[] = [
      {
        name: 'list_roles',
        description:
          "The user's roles, by category (answers, build, art): what each kind of work is for and which models serve it, " +
          'in fallback order, as of now. Prefer `role` over `worker` in delegate and start_task: the extension then ' +
          'picks the model the user chose for that work, at its effort, and falls back when a plan is used up or a ' +
          'provider fails.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_workers',
        description: 'List the worker models the user enabled, with what each is good for.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'delegate',
        description:
          'Ask a worker model (another provider the user enabled) to do a focused task and return its answer. ' +
          'The worker sees ONLY `task` and `context` — paste in everything it needs (code, text, constraints). ' +
          'It cannot read files or run commands. What you send goes to that third-party provider: send only ' +
          "what the task needs, never secrets. Check the answer before relying on it. Up to " +
          `${MAX_CONTEXT_CHARS.toLocaleString('en-US')} characters of context.`,
        inputSchema: {
          type: 'object',
          properties: {
            // No enum: a session keeps the tool definitions it started with, so a list here
            // would go stale when the user changes workers. list_workers is always current.
            role: {
              type: 'string',
              description: 'The kind of work — quick, second-opinion, review, hard-reasoning (see list_roles). Preferred: the user chose who serves each.',
            },
            worker: { type: 'string', description: `A specific worker instead of a role — see list_workers (at session start: ${ids.join(', ')}).` },
            task: { type: 'string', description: 'What to do, stated completely.' },
            context: { type: 'string', description: 'The material to work on: code, text, notes.' },
            max_tokens: {
              type: 'integer',
              minimum: 64,
              maximum: MAX_OUTPUT_TOKENS,
              description: `Answer length cap (default ${DEFAULT_OUTPUT_TOKENS}).`,
            },
          },
          required: ['task'],
        },
      },
      {
        name: 'provider_usage',
        description:
          "How much of each worker provider's plan is used (e.g. the Anthropic subscription's 5-hour and weekly " +
          "windows, Z.ai's credit windows) and this window's worker calls so far. Check it to spread work across " +
          "the different services the user has, as the user's roles already do.",
        inputSchema: { type: 'object', properties: {} },
      },
      ...(lead ? this.agentTools() : []),
    ];
    return all;
  }

  private agentTools(): Json[] {
    const ids = this.source.workers().filter((w) => w.agent).map((w) => w.id);
    if (!this.agents || ids.length === 0) return [];
    const id = { type: 'string', description: 'The task_id start_task returned.' };
    return [
      {
        name: 'stop_check',
        description: "Internal: called by CPPO's Stop hook so a session isn't ended while its agent tasks run. Do not call it yourself.",
        inputSchema: { type: 'object', properties: { transcript_path: { type: 'string' }, session_id: { type: 'string' }, stop_hook_active: { type: 'string' } } },
      },
      {
        name: 'start_task',
        description:
          'Start an agent task: a worker model (another provider the user enabled) runs headless on a scratch git ' +
          "worktree of this repo — HEAD plus the user's uncommitted changes — editing files and running commands: " +
          'Claude Code in auto mode (actions checked by a safety classifier), or for Codex workers Codex itself in its ' +
          'workspace-write sandbox (no network for commands). It can consult other workers itself, answers only ' +
          "(e.g. Claude on the user's subscription). Returns a task_id at once; tasks take minutes. The worker " +
          'sees only its copy and what you put in task/context: gitignored files (scratch folders, build output) ' +
          'are not in it unless listed in `include` — or named in task/context by absolute path, which copies ' +
          "that file in. Keep calling wait_task until it is done, then review the diff and apply or report it; don't end your turn while it runs.",
        inputSchema: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              description:
                'The kind of work — implement, test-and-fix, vector-art, 2d-art (raster images via Codex; ask for the files to be saved in the repo) — see list_roles. Preferred.',
            },
            worker: { type: 'string', description: `A specific agent-enabled worker instead of a role — see list_workers (at session start: ${ids.join(', ')}).` },
            task: { type: 'string', description: 'The job, stated completely, with how to verify it.' },
            context: { type: 'string', description: 'Anything it needs beyond the repo itself.' },
            include: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Files or folders (relative to the repo root) to copy into the worker\'s copy even though they are ' +
                'gitignored — only what the task needs (5 MB a file, 100 MB and 2,000 files in all). Not with `after`.',
            },
            minutes: {
              type: 'integer',
              minimum: TASK_LIMITS.minutes.min,
              maximum: TASK_LIMITS.minutes.max,
              description: `Time limit (default ${TASK_LIMITS.minutes.default}). Builds and test loops take long; changes so far are kept if it runs out.`,
            },
            max_turns: {
              type: 'integer',
              minimum: TASK_LIMITS.turns.min,
              maximum: TASK_LIMITS.turns.max,
              description: `Turn limit (default ${TASK_LIMITS.turns.default}).`,
            },
            after: {
              type: 'string',
              description:
                "Chain: start from this task's result instead of the user's repo (waits for it if it is still running). " +
                'Also continues a task stopped at its limit: the follow-up starts from its changes and is told where it stopped. ' +
                'Applying a chained task also applies the unapplied tasks before it.',
            },
          },
          required: ['task'],
        },
      },
      {
        name: 'wait_task',
        description: "Wait for an agent task (up to `seconds`), then return its status — or, when done, the worker's report and the diff of its changes.",
        inputSchema: {
          type: 'object',
          properties: { task_id: id, seconds: { type: 'integer', minimum: 1, maximum: 240, description: 'How long to wait, at most 240 s (default 120); call again if it is still running.' } },
          required: ['task_id'],
        },
      },
      {
        name: 'cancel_task',
        description: 'Stop a running agent task (its changes so far are still collected).',
        inputSchema: { type: 'object', properties: { task_id: id }, required: ['task_id'] },
      },
      {
        name: 'apply_task_changes',
        description:
          "Apply a finished task's diff to the user's working tree (unstaged). Only after you reviewed the diff from wait_task.",
        inputSchema: { type: 'object', properties: { task_id: id }, required: ['task_id'] },
      },
    ];
  }

  /** Refreshes what can be read without spending anything (Z.ai's monitor), then formats the book. */
  async usageReport(): Promise<string> {
    const ws = this.source.workers();
    await this.refreshUsage();
    return this.usage.format([...new Set([LOGIN_PROVIDER, ...ws.map((w) => w.providerName)])]);
  }

  private async call(name: string, args: Json, caller: 'lead' | 'agent' = 'lead'): Promise<Json> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });
    if (name === 'stop_check') {
      try {
        if (caller !== 'lead' || !this.agents || typeof args.transcript_path !== 'string' || !args.transcript_path) return text('{}');
        const transcript = readTranscriptTail(args.transcript_path);
        const key = typeof args.session_id === 'string' ? args.session_id : '';
        const count = this.stopBlocks.get(key) ?? 0;
        const decision = decideStop({ transcript, task: (id) => this.agents!.view(id), blocksInARow: count });
        this.stopBlocks.set(key, decision.block ? count + 1 : 0);
        if (!decision.block) return text('{}');
        const tasks = sessionTasks(transcript).started.map((id) => this.agents!.view(id)).filter((t) => t !== undefined);
        log(`workers: stop blocked (${count + 1}; ${tasks.length} tasks; workers: ${[...new Set(tasks.map((t) => t.worker))].join(', ')})`);
        return text(JSON.stringify({ decision: 'block', reason: decision.reason }));
      } catch {
        return text('{}');
      }
    }
    if (name === 'list_workers') {
      const ws = this.source.workers();
      return text(ws.map((w) => `- ${w.id}: ${w.note} (${w.providerName}, model ${w.model})`).join('\n') || 'No workers are enabled.');
    }
    if (name === 'provider_usage') return text(await this.usageReport());
    if (this.agents && ['start_task', 'wait_task', 'cancel_task', 'apply_task_changes'].includes(name)) {
      try {
        const id = String(args.task_id ?? '');
        if (name === 'start_task') {
          const routed = await this.route(args, 'agent');
          if ('error' in routed) return text(routed.error, true);
          // A task is long: it starts on the first entry that can run now (no retry mid-run).
          const { worker: w, effort } = routed.order[0];
          const passed = routed.skipped.map((x) => `${x.worker} skipped: ${x.reason}`);
          const task = typeof args.task === 'string' ? args.task.trim() : '';
          if (!task) return text('`task` is required.', true);
          const context = typeof args.context === 'string' ? args.context : undefined;
          if (task.length + (context?.length ?? 0) > MAX_CONTEXT_CHARS) return text(`Too much to send (limit ${MAX_CONTEXT_CHARS} characters).`, true);
          const after = typeof args.after === 'string' && args.after ? args.after : undefined;
          const include = Array.isArray(args.include) ? args.include.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
          const r = await this.agents.start(w.id, task, {
            context,
            after,
            include,
            role: routed.role,
            effort,
            minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
            maxTurns: typeof args.max_turns === 'number' ? args.max_turns : undefined,
          });
          return text(
            `${r.queued ? 'Queued' : 'Started'} task ${r.id} on ${w.id}${after ? `, building on ${after}` : ''}` +
              `${r.queued ? (after ? ` — it starts when ${after} is done` : ' — it starts when a slot frees') : ''}. ` +
              `${routed.role ? ` Role ${routed.role}${effort ? `, effort ${effort}` : ''}${passed.length ? ` (${passed.join('; ')})` : ''}.` : ''}` +
              ` Don't end your turn while it runs: call wait_task with task_id "${r.id}" now (it waits up to 4 minutes) and keep calling it until the task is done, then review the diff and apply or report it.${r.note ? `\n\nSnapshot: ${r.note}` : ''}`
          );
        }
        if (name === 'wait_task') {
          const r = await this.agents.wait(id, Number(args.seconds) || 120);
          return text(r.text, r.isError);
        }
        if (name === 'cancel_task') return text(this.agents.cancel(id));
        const r = await this.agents.apply(id);
        return text(r.text, r.isError);
      } catch (err) {
        return text((err as Error).message, true);
      }
    }
    if (name === 'list_roles') return text(await this.rolesReport());
    if (name !== 'delegate') return text(`Unknown tool ${name}.`, true);
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const context = typeof args.context === 'string' ? args.context : undefined;
    if (!task) return text('`task` is required.', true);
    if ((context?.length ?? 0) + task.length > MAX_CONTEXT_CHARS) {
      return text(`Too much to send: ${(context?.length ?? 0) + task.length} characters (limit ${MAX_CONTEXT_CHARS}). Send only what the task needs.`, true);
    }
    const maxTokens = Math.min(Math.max(Number(args.max_tokens) || DEFAULT_OUTPUT_TOKENS, 64), MAX_OUTPUT_TOKENS);
    const routed = await this.route(args, 'answer');
    if ('error' in routed) return text(routed.error, true);
    const notes = routed.skipped.map((s) => `${s.worker} skipped: ${s.reason}`);
    for (let i = 0; i < routed.order.length; i++) {
      const { worker: w, effort } = routed.order[i];
      const r = await this.consultOnce(w, effort, task, context, maxTokens, caller, routed.role);
      if ('answer' in r) {
        const via = routed.role ? ` · role ${routed.role}${effort ? `, effort ${effort}` : ''}` : '';
        return text(`${r.answer || '(empty answer)'}\n\n— ${w.id}${via} · ${r.meta}${notes.length ? `\n(${notes.join('; ')})` : ''}`);
      }
      notes.push(`${w.id} failed: ${r.error}`);
      if (!routed.role || i === routed.order.length - 1 || !worthFallingBack(r.error)) {
        return text(`Worker ${w.id} failed: ${r.error}${notes.length > 1 ? `\n(${notes.slice(0, -1).join('; ')})` : ''}`, true);
      }
      log(`workers: role ${routed.role}: ${w.id} failed (${r.error.slice(0, 120)}), falling back to ${routed.order[i + 1].worker.id}`);
    }
    return text('No worker could serve it.', true);
  }

  /**
   * Who serves a call: the worker named, or — for a `role` — its chain in the
   * order it would be tried now (roles.ts), with the entries passed over and why.
   */
  private async route(
    args: Json,
    kind: 'answer' | 'agent'
  ): Promise<{ order: Array<{ worker: Worker; effort?: Effort }>; skipped: Skip[]; role?: string } | { error: string }> {
    const ws = this.source.workers();
    const roleId = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : undefined;
    if (!roleId) {
      const w = ws.find((x) => x.id === args.worker && (kind === 'answer' || x.agent));
      if (!w) {
        const ids = ws.filter((x) => kind === 'answer' || x.agent).map((x) => x.id);
        return { error: `No ${kind === 'agent' ? 'agent-task ' : ''}worker "${String(args.worker ?? '')}". Pass \`role\` (see list_roles) or one of: ${ids.join(', ') || 'none'}.` };
      }
      return { order: [{ worker: w }], skipped: [] };
    }
    const def = roleDef(roleId);
    if (!def) return { error: `No role "${roleId}". Roles: ${CATALOG.map((r) => r.id).join(', ')}.` };
    if ((def.kind === 'answer') !== (kind === 'answer')) {
      return { error: `Role "${roleId}" is for ${def.kind === 'answer' ? 'delegate' : 'start_task'}.` };
    }
    await this.refreshUsage();
    const unavailable = await this.unavailable(ws);
    const r = candidates(this.policy(), roleId, ws, (p) => this.usage.get(p), (w) => unavailable.get(w.id));
    if (!r) return { error: `Role "${roleId}" is turned off.` };
    if (r.order.length === 0) {
      return {
        error:
          `No worker can serve role "${roleId}" now` +
          (r.skipped.length ? `: ${r.skipped.map((s) => `${s.worker} — ${s.reason}`).join('; ')}` : ' — its chain is empty (CPPO: Orchestration).'),
      };
    }
    return { ...r, role: roleId };
  }

  /** The user's roles, or the template from the configured workers. */
  policy(): RolePolicy {
    return effectivePolicy(this.source.rolePolicy(), this.source.workers());
  }

  /** Why a worker can't run here right now (no key, no Codex, no account dir) — absent when it can. */
  async unavailable(ws: Worker[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const codex = new Map<string, boolean>();
    for (const w of ws) {
      if (w.kind === 'login') {
        if (!this.source.loginDir()) out.set(w.id, "this window's account has no directory of its own");
      } else if (w.kind === 'codex') {
        if (!codex.has(w.providerId)) codex.set(w.providerId, Boolean(await this.source.codexContext(w.providerId)));
        if (!codex.get(w.providerId)) out.set(w.id, 'Codex not available (no `codex` on this host, or no key)');
      } else if (!(await this.source.keyFor(w.providerId))) {
        out.set(w.id, `no key stored for ${w.providerName}`);
      }
    }
    return out;
  }

  /** One consultation on one worker, with its bookkeeping (transcript, usage, log). */
  private async consultOnce(
    w: Worker,
    effort: Effort | undefined,
    task: string,
    context: string | undefined,
    maxTokens: number,
    caller: 'lead' | 'agent',
    role?: string
  ): Promise<{ answer: string; meta: string } | { error: string }> {
    if (this.calls >= MAX_CALLS) return { error: `this window reached its limit of ${MAX_CALLS} worker calls; reload the window to reset it` };
    let run: () => Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number; rateLimit?: Record<string, unknown> }>;
    if (w.kind === 'login') {
      const dir = this.source.loginDir();
      if (!dir) return { error: "this window's account has no directory of its own to run Claude on" };
      run = () => callLoginWorker(w, dir, task, context, effort);
    } else if (w.kind === 'codex') {
      const ctx = await this.source.codexContext(w.providerId);
      if (!ctx) return { error: `Codex isn't available for ${w.providerName}: no \`codex\` on this host, or no stored API key` };
      run = () => callCodexWorker(ctx, w.model, WORKER_SYSTEM, task, context, CALL_TIMEOUT_MS, clampEffort(effort, w.efforts));
    } else {
      const key = await this.source.keyFor(w.providerId);
      if (!key) return { error: `no key is stored for ${w.providerName}` };
      run = () => callWorker(w, key, task, context, maxTokens, effort);
    }
    this.calls++;
    const busy = vscode.window.setStatusBarMessage(`$(sync~spin) Worker ${w.id}…`);
    const consult: Consult = { n: this.calls, worker: w.id, caller, at: Date.now(), task, context, role, effort };
    this.consults.push(consult);
    if (this.consults.length > KEEP_CONSULTS) this.consults.shift();
    this.onDidConsult.fire(consult);
    try {
      const r = await run();
      Object.assign(consult, { answer: r.text, ms: r.ms, inTok: r.inputTokens, outTok: r.outputTokens });
      if (r.rateLimit) {
        const windows = fromRateLimitInfo(r.rateLimit);
        if (windows.length) this.usage.set(w.providerName, { windows, source: "Claude Code's rate-limit report", at: Date.now() });
      }
      this.usage.count(w.id, 'call', r.inputTokens, r.outputTokens);
      log(`workers: ${w.id} answered${caller === 'agent' ? ' an agent task' : ''}${role ? ` (role ${role})` : ''} in ${r.ms} ms (${r.inputTokens ?? '?'} in / ${r.outputTokens ?? '?'} out tokens)`);
      return { answer: r.text, meta: `${r.ms} ms · ${r.inputTokens ?? '?'} in / ${r.outputTokens ?? '?'} out tokens` };
    } catch (err) {
      consult.error = (err as Error).message;
      log(`workers: ${w.id} failed — ${(err as Error).message}`);
      return { error: (err as Error).message };
    } finally {
      busy.dispose();
      this.onDidConsult.fire(consult);
    }
  }

  /** Plan usage, freshened when older than five minutes (or now, with `force`) — Codex and Z.ai can be read any time. */
  async refreshUsage(force = false): Promise<void> {
    // The Anthropic plan: Claude Code's own cached report, whenever it's fresher than what we have.
    const { dirs, email } = this.source.claudeUsageDirs();
    const cc = claudeCodeUsage(dirs, email);
    const had = this.usage.get(LOGIN_PROVIDER);
    if (cc && (!had || cc.at > had.at)) this.usage.set(LOGIN_PROVIDER, cc);
    const seen = new Set<string>();
    for (const w of this.source.workers()) {
      if ((w.preset !== 'zai' && w.kind !== 'codex') || seen.has(w.providerId)) continue;
      seen.add(w.providerId);
      const e = this.usage.get(w.providerName);
      if (e && !force && Date.now() - e.at < 300_000) continue;
      if (w.kind === 'codex') {
        const ctx = await this.source.codexContext(w.providerId);
        const u = ctx ? await codexUsage(ctx) : undefined;
        if (u) this.usage.set(w.providerName, u);
      } else {
        const key = await this.source.keyFor(w.providerId);
        const q = key ? await zaiQuota(key) : undefined;
        if (q) this.usage.set(w.providerName, q);
      }
    }
  }

  /** list_roles: each role, what it's for, and who would serve it now, in order. */
  async rolesReport(): Promise<string> {
    const ws = this.source.workers();
    await this.refreshUsage();
    const unavailable = await this.unavailable(ws);
    const policy = this.policy();
    const lines: string[] = [];
    let category = '';
    for (const def of CATALOG) {
      if (def.category !== category) {
        category = def.category;
        lines.push(`${category}:`);
      }
      const role = policy.roles.find((r) => r.id === def.id);
      if (role?.off) continue;
      const r = candidates(policy, def.id, ws, (p) => this.usage.get(p), (w) => unavailable.get(w.id));
      const order = r?.order.map((c) => `${c.worker.id}${c.effort ? ` (${c.effort})` : ''}`) ?? [];
      lines.push(
        `- ${def.id} [${def.kind === 'answer' ? 'delegate' : 'start_task'}] — ${def.purpose}. ` +
          (order.length ? `Served by: ${order.join(' → ')}.` : 'No worker can serve it now.') +
          (r?.skipped.length ? ` Passed over: ${r.skipped.map((s) => `${s.worker} (${s.reason})`).join('; ')}.` : '')
      );
    }
    lines.push(`Thresholds: an entry is passed over past ${policy.skip5hPct}% of a 5-hour window or ${policy.skipWeeklyPct}% of a weekly one (still used when every entry is).`);
    return lines.join('\n');
  }

  dispose(): void {
    this.subscription.dispose();
    this.onDidConsult.dispose();
    const dir = this.configDir();
    if (dir) {
      try {
        registerStopHook(dir, false);
        register(dir, undefined);
      } catch {
        /* best effort on shutdown */
      }
    }
    this.stop();
  }
}

/**
 * Adds (or, with undefined, removes) the server in the dir's .claude.json
 * `mcpServers`. Read-modify-write with an atomic rename; leaves everything else
 * — Claude Code's own state — as it was, and never writes a file it can't parse.
 */
function register(dir: string, entry: Json | undefined): void {
  const file = path.join(dir, '.claude.json');
  let config: Json = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const servers = { ...((config.mcpServers as Json | undefined) ?? {}) };
  // The same server under the old extension's name: its port and token are dead.
  const legacy = LEGACY_SERVER_NAME in servers;
  delete servers[LEGACY_SERVER_NAME];
  if (entry) {
    if (!legacy && JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) return;
    servers[SERVER_NAME] = entry;
  } else {
    if (!legacy && !(SERVER_NAME in servers)) return;
    delete servers[SERVER_NAME];
  }
  config.mcpServers = servers;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Own only our handler: a user's other hooks must survive enable and disable. */
export function registerStopHook(dir: string, on: boolean): void {
  const file = path.join(dir, 'settings.json');
  let tmp: string | undefined;
  try {
    let config: Json = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      config = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    const object = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    if (config.hooks !== undefined && !object(config.hooks)) return;
    const hooks = (config.hooks ?? {}) as Json;
    if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) return;
    const groups = (hooks.Stop ?? []) as unknown[];
    const ours = (h: unknown): h is Json => object(h) && h.type === 'mcp_tool' && h.server === SERVER_NAME && h.tool === 'stop_check';
    const handler = {
      type: 'mcp_tool', server: SERVER_NAME, tool: 'stop_check',
      input: { transcript_path: '${transcript_path}', session_id: '${session_id}', stop_hook_active: '${stop_hook_active}' },
      timeout: 20,
    };
    const identical = (h: unknown) => ours(h) && h.timeout === handler.timeout && object(h.input) &&
      Object.keys(h.input).length === 3 && Object.entries(handler.input).every(([k, v]) => (h.input as Json)[k] === v) && Object.keys(h).length === 5;
    if (on && groups.some((g) => object(g) && Array.isArray(g.hooks) && g.hooks.some(identical))) return;
    let changed = false;
    const next: unknown[] = [];
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks) || !group.hooks.some(ours)) {
        next.push(group);
        continue;
      }
      changed = true;
      const remaining = group.hooks.filter((h) => !ours(h));
      if (remaining.length) next.push({ ...group, hooks: remaining });
    }
    if (on) {
      next.push({ hooks: [handler] });
      changed = true;
    }
    if (!changed) return;
    if (next.length) hooks.Stop = next;
    else delete hooks.Stop;
    if (Object.keys(hooks).length) config.hooks = hooks;
    else delete config.hooks;
    tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* A hook is optional; an unreadable config must never prevent startup. */
  } finally {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* renamed or never written */ }
    }
  }
}
