import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { log } from './log';
import { LIMIT_SNIPPET } from './proc';
import type { UsageEntry, UsageWindow } from './usage';

/**
 * OpenAI Codex as a worker: GPT models through the Codex CLI itself.
 *
 * Like the Anthropic login, a ChatGPT plan is only ever used by its own client:
 * this extension runs `codex` (signed in with `codex login`) and never reads or
 * sends its tokens. An OpenAI API key is the alternative, passed to the run as
 * CODEX_API_KEY with a Codex home of its own. An API key can also serve Claude
 * Code chat windows on GPT, through the local LiteLLM proxy (providers.ts); a
 * ChatGPT plan can't — only Codex may use it — so it's for workers and agent
 * tasks only.
 *
 * Three ways in, all of them Codex's own:
 *  - `codex exec --json`: a headless run (answers, read-only, tools off; or an
 *    agent task in a worktree, see agentTasks.ts).
 *  - `codex app-server`: JSON-RPC over stdio for the account (`account/read`),
 *    the plan's 5-hour and weekly windows (`account/rateLimits/read`, no message
 *    sent) and the model catalog (`model/list`).
 *  - `codex login`, in a terminal, for the user to sign in.
 */

export type CodexAuth = 'chatgpt' | 'api-key';

/** How to run Codex for one provider. */
export interface CodexContext {
  bin: string;
  /** CODEX_HOME for the run: the user's own for a ChatGPT plan, a private one for an API key. */
  home: string;
  /** Extra env (CODEX_API_KEY for an API key). */
  env: Record<string, string>;
  auth: CodexAuth;
  /** Reasoning efforts by model, from `model/list`, to keep a requested effort within what a model takes. */
  efforts?: Record<string, string[]>;
  /** A ChatGPT plan on a Codex home of this provider's own (not the host's shared ~/.codex). */
  own?: boolean;
}

export interface CodexModel {
  id: string;
  name: string;
  note: string;
  /** The reasoning efforts it takes (`model_reasoning_effort`). */
  efforts?: string[];
  /** Takes images as input (can look at art, screenshots). */
  vision?: boolean;
}

/** When `model/list` can't be read: the catalog as Codex 0.163 lists it. */
export const CODEX_FALLBACK_MODELS: CodexModel[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', note: 'Latest workhorse model for coding and everyday work.' },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', note: 'Frontier intelligence for the most demanding work.' },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', note: 'Previous generation workhorse model.' },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', note: 'Fast and affordable model for easier tasks.' },
];

/**
 * Tools a consultation never needs. A worker answers from what the lead sent:
 * no shell, no browser, no plugins — in an empty directory, read-only anyway.
 */
const ANSWER_ONLY_DISABLED = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'multi_agent'];

/** Agent tasks: Codex's own tools, minus what reaches beyond the worktree (desktop, browser, plugins). */
export const AGENT_DISABLED = ['apps', 'plugins', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use'];

/**
 * Shell arguments that run Codex with `args` through a login shell (the agent's
 * commands see the user's PATH). With `limitSec` the trampoline instead wraps
 * the run in `timeout` (proc.ts LIMIT_SNIPPET) so a detached agent task ends at
 * its wall even with no extension host watching; the caller sets CPPO_LIMIT_S.
 */
export function codexShellArgs(bin: string, args: string[], limitSec?: number): string[] {
  return limitSec === undefined ? ['-lc', 'exec "$0" "$@"', bin, ...args] : ['-lc', LIMIT_SNIPPET, bin, ...args];
}

/** The OpenAI extension's bundled binary (`openai.chatgpt`), found by name under its bin/. */
function bundledCodex(): string | undefined {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (!ext) return undefined;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch {
          /* not executable */
        }
      } else if (e.isDirectory() && depth > 0) {
        const found = walk(p, depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(path.join(ext.extensionPath, 'bin'), 3);
}

let cached: string | undefined;

/** The Codex binary: the OpenAI extension's, else `codex` on the login shell's PATH. Undefined if neither. */
export async function codexBinary(): Promise<string | undefined> {
  if (cached && fs.existsSync(cached)) return cached;
  cached = bundledCodex();
  if (cached) return cached;
  cached = await new Promise<string | undefined>((resolve) => {
    execFile(process.env.SHELL || '/bin/bash', ['-lc', 'command -v codex'], { timeout: 15_000 }, (err, stdout) =>
      resolve(err ? undefined : stdout.toString().trim().split('\n').pop() || undefined)
    );
  });
  return cached;
}

/** Codex's own home for a ChatGPT plan: where `codex login` keeps the sign-in. */
export function userCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** A private Codex home for an API-key provider, so its runs never touch the user's own sign-in or config. */
export function keyCodexHome(root: string, providerId: string): string {
  const dir = path.join(root, 'codex', providerId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Losing the provider state can leave private Codex homes with live sign-ins
 * behind. Offer those homes again, without reading the credentials themselves.
 */
export function findOrphanCodexHomes(root: string, referenced: ReadonlySet<string>): Array<{ id: string; dir: string }> {
  const base = path.join(root, 'codex');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const homes: Array<{ id: string; dir: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || referenced.has(entry.name)) continue;
    const dir = path.join(base, entry.name);
    try {
      const auth = fs.lstatSync(path.join(dir, 'auth.json'));
      if (auth.isFile()) homes.push({ id: entry.name, dir, mtime: auth.mtimeMs });
    } catch {
      /* no readable sign-in file, or the home disappeared */
    }
  }
  return homes.sort((a, b) => b.mtime - a.mtime).map(({ id, dir }) => ({ id, dir }));
}

function runEnv(ctx: CodexContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Only this provider's credential: never a key the window or the shell happens to carry.
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR' || k === 'OPENAI_API_KEY' || k === 'CODEX_API_KEY') delete env[k];
  return { ...env, CODEX_HOME: ctx.home, ...ctx.env };
}

/**
 * Sends `requests` to a short-lived `codex app-server` and returns each result
 * (or error) by method. JSON-RPC over stdio, one JSON object a line.
 */
export function appServer(
  ctx: CodexContext,
  requests: Array<{ method: string; params?: unknown }>,
  timeoutMs = 20_000
): Promise<Record<string, { result?: unknown; error?: { message?: string } }>> {
  return new Promise((resolve) => {
    const out: Record<string, { result?: unknown; error?: { message?: string } }> = {};
    const child = spawn(ctx.bin, ['app-server'], { env: runEnv(ctx), stdio: ['pipe', 'pipe', 'ignore'] });
    const done = () => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* gone */
      }
      resolve(out);
    };
    const timer = setTimeout(done, timeoutMs);
    const byId = new Map<number, string>();
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 0) {
          // Initialized: now the real requests.
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          requests.forEach((r, i) => {
            byId.set(i + 1, r.method);
            child.stdin.write(JSON.stringify({ id: i + 1, method: r.method, ...(r.params !== undefined && { params: r.params }) }) + '\n');
          });
          if (requests.length === 0) done();
        } else if (typeof msg.id === 'number' && byId.has(msg.id)) {
          out[byId.get(msg.id)!] = { result: msg.result, error: msg.error };
          if (Object.keys(out).length === requests.length) done();
        }
      }
    });
    child.on('error', done);
    child.on('close', done);
    child.stdin.write(
      JSON.stringify({ id: 0, method: 'initialize', params: { clientInfo: { name: 'cppo', title: 'CPPO', version: '1' }, capabilities: null } }) + '\n'
    );
  });
}

export interface CodexAccount {
  type: 'chatgpt' | 'apiKey' | string;
  email?: string;
  plan?: string;
}

/** Who Codex is signed in as (ChatGPT plan) — undefined when it isn't. */
export async function codexAccount(ctx: CodexContext): Promise<CodexAccount | undefined> {
  const r = await appServer(ctx, [{ method: 'account/read', params: { refreshToken: false } }]);
  const a = (r['account/read']?.result as { account?: { type?: string; email?: string | null; planType?: string } | null } | undefined)?.account;
  return a?.type ? { type: a.type, email: a.email ?? undefined, plan: a.planType ?? undefined } : undefined;
}

/** The models Codex offers this account, from `model/list`; the fallback list if it can't be read. */
export async function codexModels(ctx: CodexContext): Promise<CodexModel[]> {
  const r = await appServer(ctx, [{ method: 'model/list', params: {} }]);
  const data = (
    r['model/list']?.result as
      | { data?: Array<{ id?: string; displayName?: string; description?: string; hidden?: boolean; inputModalities?: string[]; supportedReasoningEfforts?: Array<{ reasoningEffort?: string }> }> }
      | undefined
  )?.data;
  const models = (data ?? [])
    .filter((m) => m.id && !m.hidden)
    .map((m) => ({
      id: m.id!,
      name: m.displayName ?? m.id!,
      note: m.description ?? '',
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e): e is string => Boolean(e)),
      vision: (m.inputModalities ?? []).includes('image'),
    }));
  return models.length ? models : CODEX_FALLBACK_MODELS;
}

/** What this account's Codex can do beyond text: image generation (2D art), web search. */
export async function codexCapabilities(ctx: CodexContext): Promise<{ imageGeneration: boolean; webSearch: boolean } | undefined> {
  const r = await appServer(ctx, [{ method: 'modelProvider/capabilities/read', params: {} }]);
  const c = r['modelProvider/capabilities/read']?.result as { imageGeneration?: boolean; webSearch?: boolean } | undefined;
  return c ? { imageGeneration: Boolean(c.imageGeneration), webSearch: Boolean(c.webSearch) } : undefined;
}

type Window = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null } | null | undefined;

function span(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins % 10080 === 0) return mins === 10080 ? 'per week' : `per ${mins / 10080} weeks`;
  if (mins % 1440 === 0) return mins === 1440 ? 'per day' : `per ${mins / 1440} days`;
  if (mins % 60 === 0) return `per ${mins / 60} hours`;
  return `per ${mins} minutes`;
}

/**
 * The ChatGPT plan's Codex limits — the 5-hour and weekly windows — from
 * `account/rateLimits/read`. Read without sending a message.
 */
export async function codexUsage(ctx: CodexContext): Promise<UsageEntry | undefined> {
  if (ctx.auth !== 'chatgpt') return undefined; // an API key has no plan windows, only tokens
  const r = await appServer(ctx, [{ method: 'account/rateLimits/read' }]);
  const res = r['account/rateLimits/read']?.result as
    | { rateLimits?: { primary?: Window; secondary?: Window; planType?: string | null; limitName?: string | null }; rateLimitsByLimitId?: Record<string, { primary?: Window; secondary?: Window; limitName?: string | null } | undefined> | null }
    | undefined;
  if (!res?.rateLimits) {
    if (r['account/rateLimits/read']?.error) log(`codex usage: ${r['account/rateLimits/read'].error?.message}`);
    return undefined;
  }
  const windows: UsageWindow[] = [];
  const add = (w: Window, fallback: string, prefix = '') => {
    if (!w || typeof w.usedPercent !== 'number') return;
    windows.push({ label: `${prefix}${span(w.windowDurationMins, fallback)}`, usedPct: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined });
  };
  add(res.rateLimits.primary, 'per 5 hours');
  add(res.rateLimits.secondary, 'per week');
  // Further metered buckets (some models have limits of their own).
  for (const [id, s] of Object.entries(res.rateLimitsByLimitId ?? {})) {
    if (!s || id === 'codex') continue;
    add(s.primary, 'per 5 hours', `${s.limitName ?? id}: `);
    add(s.secondary, 'per week', `${s.limitName ?? id}: `);
  }
  return { plan: res.rateLimits.planType ?? undefined, windows, source: "Codex's own usage report", at: Date.now() };
}

export type CodexTest = { ok: true; detail: string } | { ok: false; message: string; hint: string };

/**
 * The connection test. ChatGPT plan: Codex says who it's signed in as (no
 * message sent). API key: OpenAI's model list with that key (free).
 */
export async function testCodex(ctx: CodexContext, key?: string): Promise<CodexTest> {
  if (ctx.auth === 'chatgpt') {
    const a = await codexAccount(ctx);
    if (a?.type === 'chatgpt') return { ok: true, detail: `signed in as ${a.email ?? 'a ChatGPT account'}${a.plan ? ` (${a.plan})` : ''}` };
    return {
      ok: false,
      message: a
        ? `Codex is signed in with ${a.type === 'apiKey' ? 'an API key' : a.type}, not a ChatGPT plan.`
        : ctx.own
          ? "This provider's own Codex sign-in isn't set up yet."
          : "Codex isn't signed in on this host.",
      hint: ctx.own
        ? "Sign in to the ChatGPT account you want for this provider (Sign in to Codex below opens a terminal for it). It's separate from other providers' and from ~/.codex."
        : 'Sign in with your ChatGPT account: run `codex login` (Sign in to Codex below opens a terminal for it).',
    };
  }
  try {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key ?? ''}` }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { ok: true, detail: 'the API key works' };
    return {
      ok: false,
      message: `OpenAI answered HTTP ${res.status}.`,
      hint: res.status === 401 ? 'The key was rejected — check it at platform.openai.com/api-keys.' : 'OpenAI answered with an error.',
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message, hint: "Couldn't reach api.openai.com." };
  }
}

/** One `codex exec --json` event (the parts this extension reads). */
export interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    changes?: Array<{ path?: string; kind?: string }>;
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: unknown;
    query?: string;
    items?: Array<{ text?: string; completed?: boolean }>;
  };
}

/**
 * A consultation on Codex: one headless run, read-only, in an empty directory,
 * with its tools switched off — the task and the lead's material, nothing else.
 * The prompt goes in on stdin (an argument is capped at 128 KB on Linux).
 */
export function callCodexWorker(
  ctx: CodexContext,
  model: string,
  system: string,
  task: string,
  context: string | undefined,
  timeoutMs: number,
  effort?: string
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number }> {
  const prompt = `${system}\n\n<task>\n${task}\n</task>${context ? `\n\n<context>\n${context}\n</context>` : ''}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-codex-'));
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '-m', model, '-C', dir,
    ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    ...ANSWER_ONLY_DISABLED.flatMap((f) => ['--disable', f]),
    '-',
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.bin, args, { cwd: dir, env: runEnv(ctx), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let text = '';
    let inTok = 0;
    let outTok = 0;
    let failed: string | undefined;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onLine = (line: string) => {
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = ev.item.text;
      if (ev.type === 'turn.completed') {
        inTok += ev.usage?.input_tokens ?? 0;
        outTok += (ev.usage?.output_tokens ?? 0) + (ev.usage?.reasoning_output_tokens ?? 0);
      }
      // `error` events are often retries ("Reconnecting... 2/5"); only a failed turn is final.
      if (ev.type === 'turn.failed') failed = ev.error?.message ?? 'the run failed';
    };
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      if (buf.trim()) onLine(buf);
      if (failed || (!text && code !== 0)) {
        const last = err.trim().split('\n').filter((l) => !/bubblewrap/i.test(l)).slice(-2).join(' ');
        reject(new Error(failed ?? (code === null ? 'timed out' : `codex exited with ${code}${last ? `: ${last}` : ''}`)));
      } else {
        resolve({ text, inputTokens: inTok, outputTokens: outTok, ms: Date.now() - started });
      }
    });
    child.stdin.end(prompt);
  });
}
