import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import type { TaskView } from './handoff';
import { workingRoot } from './workdir';
import { log } from './log';
import { MCP_CALL_TIMEOUT_MS } from './delegate';
import { claudeShellArgs } from './cli';
import { fence, details, clip } from './transcripts';
import { AgyContext, AgyModel, AgyEvent, AgyDenied, agyAgentArgs, agyPermissions, agyPromptArgs, agyRunEnv, agySlug, collectAgyImages, deniedOf, describeDenied, parseAgyLine, removeAgyMcpConfig, writeAgyMcpConfig } from './agy';
import { AGENT_DISABLED, CodexContext, CodexEvent, codexShellArgs } from './codex';
import { clampEffort, Effort } from './roles';
import { killSession, LIMIT_SNIPPET, sessionPids } from './proc';

/**
 * Agent tasks: a worker that does real work, not just answers.
 *
 * Each task is a headless `claude -p` on the worker's provider (e.g. GLM on
 * Z.ai), in auto mode, inside a git worktree made from a snapshot of the
 * user's repo — HEAD plus uncommitted changes (untracked files included,
 * .gitignore respected), built with a temporary index so the user's own index
 * is never touched. The run gets a fresh config: none of the user's login,
 * plugins or MCP servers, and the provider key only in its process
 * environment. When it ends, the worktree's changes are collected as a patch
 * against the snapshot and the worktree is removed; the lead reviews the patch
 * and, if it wants, applies it to the working tree (never the index).
 *
 * Auto mode checks each consequential action (commands, network) with a
 * classifier on the worker's own model — about 35K tokens per check on Z.ai.
 *
 * A task survives its extension host. The run is a DETACHED process in its own
 * session, its stream redirected to <dir>/log.jsonl (no pipes that a host exit
 * would break), wrapped so `timeout` ends it at its wall even with no host
 * watching. Its state is mirrored to <dir>/task.json after every change, and
 * the window that owns it (keyed by owner, the window's working dir) re-adopts
 * a still-running task — or collects one that finished while no host was up —
 * when the host comes back after a reload, a crash or an SSH reconnect. The
 * lead can still wait_task/apply_task_changes it by id; dispose() kills
 * nothing, so the next host always finds the work.
 */

export interface AgentRunSpec {
  /** Who runs the task: Claude Code (default), Codex itself, or Google AI (edit-only). */
  runner?: 'claude' | 'codex' | 'google';
  /** Codex only: how to run it. */
  codex?: CodexContext;
  /** Google AI only: its CLI context and real model families. */
  google?: { ctx: AgyContext; models: AgyModel[] };
  /** The model id the runner should use, as the provider names it (e.g. "glm-5.3[1m]", "gpt-6.1-sol"). */
  runModel: string;
  /** settings.json for the run — no secrets. */
  settings: Record<string, unknown>;
  /** Secret env (the provider key), passed to the process only. */
  secretEnv: Record<string, string>;
  /** Approve an ANTHROPIC_API_KEY for the run's config (Claude Code asks about custom keys). */
  approveKeyTail?: string;
}

type Status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

interface Task {
  id: string;
  /** The window (working dir) that owns this task — only it restores the task after a restart. */
  owner?: string;
  worker: string;
  task: string;
  context?: string;
  /** Builds on this task's result (chained tasks). */
  after?: string;
  /** Commit of the task's included changes on top of `base` — what a chained task starts from. */
  result?: string;
  status: Status;
  dir: string;
  repo: string;
  base: string;
  worktree: string;
  started: number;
  ended?: number;
  child?: ChildProcess;
  /** Session leader of the run (the exec'd trampoline): what kill() and liveness use. */
  pid?: number;
  /** The extension host process currently managing the run; cleared when it goes away. */
  supervisor?: number;
  turns: number;
  toolUses: number;
  lastAction?: string;
  report?: string;
  error?: string;
  costUsd?: number;
  inTok?: number;
  outTok?: number;
  patchFile?: string;
  stat?: string;
  files?: string[];
  /** Files the worker wrote with its file tools (worktree-relative). New files only land if listed here. */
  written: Set<string>;
  /** New files that only appeared as side effects of commands (build output, caches) — left out of the patch. */
  sideEffects?: string[];
  /** Dependency folders linked into the worktree (DEP_DIRS). */
  links?: string[];
  /** What the snapshot left out (untracked over budget, LFS files), for the worker and the lead. */
  snapshotNote?: string;
  minutes: number;
  maxTurns: number;
  /** The worker's latest message — what a follow-up to a stopped run is told it was doing. */
  lastText?: string;
  lastOutput?: number;
  cancelling?: boolean;
  /** Who ran it — Claude Code, Codex or Google AI — and on which model. */
  runner?: 'claude' | 'codex' | 'google';
  model?: string;
  /** Google stream state and the temporary consulting config owned by this run. */
  google?: { ctx: AgyContext; mcp: boolean };
  conversationId?: string;
  denied?: AgyDenied[];
  googleResult?: boolean;
  googleText?: Map<number, string>;
  /** Started for a role (roles.ts), at this effort. */
  role?: string;
  effort?: Effort;
  applied?: boolean;
  waiters: Array<() => void>;
  // ── Runtime-only (never in task.json) ─────────────────────────────────────
  /** The log tailer: open fd, byte offset, partial line, and its poll timer. */
  tail?: { fd: number; offset: number; buf: string; timer?: NodeJS.Timeout };
  wall?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  /** For a re-adopted run with no child handle: polls the session for liveness. */
  poll?: NodeJS.Timeout;
  /** The runner's own terminal event was seen (Claude `result`, Codex `turn.completed`, Google `result`). */
  sawResult?: boolean;
  /** kill() was asked for while replaying a log; applied after the replay. */
  killPending?: boolean;
  /** Last task.json written, so unchanged saves are free. */
  savedJson?: string;
}

const MAX_RUNNING = 2;
/**
 * Each run's limits. Real work (a C++ build, then fixing what it reports) runs
 * well past half an hour — two GLM runs were cut off at a 30-minute limit
 * mid-build with ~900 and ~1,900 lines written. The lead can set its own per
 * task within the bounds; a run silent for IDLE_MS is taken as stuck. IDLE_MS
 * is generous on purpose: a run emits nothing while one long command runs (a
 * build, a test loop — Codex's shell commands have no short cap either).
 */
export const TASK_LIMITS = {
  minutes: { default: 120, min: 5, max: 480 },
  turns: { default: 300, min: 10, max: 1000 },
};
const IDLE_MS = 45 * 60_000;
const KEEP_DAYS = 7;
const MAX_DIFF_IN_RESULT = 60_000;

/**
 * Snapshot budgets. A repo's untracked content can be anything — one project
 * had 162 GB of scratch data in an un-ignored `.temp`, and `git add -A` began
 * hashing all of it into the repo's object store, once per task. So untracked
 * files are taken one by one within these limits; the rest is left out and
 * reported, and LFS-managed files are never added (their content would be
 * copied into LFS storage).
 */
const UNTRACKED_FILE_MAX = 5 * 1024 * 1024;
const UNTRACKED_TOTAL_MAX = 100 * 1024 * 1024;
const UNTRACKED_COUNT_MAX = 2_000;
/** How many untracked paths to look at before giving up counting. */
const UNTRACKED_SCAN_MAX = 200_000;
/** A worktree checks HEAD out in full: refuse repos whose tracked files exceed this. */
const CHECKOUT_MAX_BYTES = 5 * 1024 ** 3;
const SNAPSHOT_GIT_TIMEOUT_MS = 120_000;
/**
 * Paths copied in by name even though the rules above leave them out — a
 * gitignored scratch file the task needs, say. Their own budget, the same
 * size limit a file.
 */
const INCLUDE_TOTAL_MAX = 100 * 1024 * 1024;
const INCLUDE_COUNT_MAX = 2_000;

/**
 * Dependency folders a worktree lacks — they're gitignored, so a snapshot
 * leaves them out — linked in from the user's repo so an agent can build and
 * test (GLM couldn't typecheck this very repo without node_modules). Top-level
 * only; each link is removed again before the changes are collected.
 */
/** New files that are caches or build output, never the work — for runners that create files through the shell. */
const CACHE_LIKE = /(^|\/)(__pycache__|node_modules|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|\.turbo|\.venv|venv|dist|build|target|coverage)\/|\.(pyc|pyo|o|obj|class|log|tmp|swp|orig|rej)$|~$/i;

const DEP_DIRS = ['node_modules', '.venv', 'venv', '.virtualenv', 'vendor', '.bundle', 'bower_components', 'Pods', '.gradle'];

/** The workers MCP server, as agent runs see it (restricted token: consult tools only). */
const CONSULT_SERVER = 'cppo';
const CONSULT_TOOLS = ['delegate', 'list_roles', 'list_workers', 'provider_usage'];
const CONSULT_INSTRUCTIONS =
  ' You can consult other models with the `delegate` tool (answers only — paste in what they need), ' +
  "e.g. Claude on the user's subscription for a second opinion on a tricky change. `list_workers` shows who " +
  'is available, `provider_usage` how much of each plan is left; consult when it helps, not for every step.';

/**
 * Files under the repo that `text` names by absolute path ("/repo/.temp/Plan v2.md").
 * Names may hold spaces, so each mention is tried from its longest reading down.
 * Files only: a folder named in passing can be anything (one was 162 GB).
 */
function mentionedFiles(repo: string, text: string): string[] {
  const found = new Set<string>();
  const prefix = repo + '/';
  for (let i = text.indexOf(prefix); i >= 0; i = text.indexOf(prefix, i + 1)) {
    let candidate = text.slice(i + prefix.length, i + prefix.length + 400).split(/[\n`'"<>|*]/)[0];
    for (let tries = 0; candidate && tries < 40; tries++) {
      const rel = path.normalize(candidate.replace(/[\s).,;:\]]+$/, ''));
      try {
        if (rel && !rel.startsWith('..') && fs.statSync(path.join(repo, rel)).isFile()) {
          found.add(rel.split(path.sep).join('/'));
          break;
        }
      } catch {
        /* not this reading */
      }
      const cut = candidate.search(/\s\S*$/);
      if (cut <= 0) break;
      candidate = candidate.slice(0, cut);
    }
  }
  return [...found];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, opts: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 0, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed;
          reject(new Error(killed ? `git ${args[0]} took longer than ${Math.round((opts.timeoutMs ?? 0) / 1000)} s and was stopped` : `git ${args[0]}: ${(stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')}`));
        } else resolve(stdout.toString());
      }
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Lists NUL-separated paths from a git command, streaming (an untracked tree can be huge), up to `max`. */
function gitPaths(cwd: string, args: string[], max: number): Promise<{ paths: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const paths: string[] = [];
    let buf = '';
    let truncated = false;
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\0')) >= 0) {
        if (paths.length >= max) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        paths.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve({ paths, truncated }));
  });
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'CPPO',
  GIT_AUTHOR_EMAIL: 'agent-task@localhost',
  GIT_COMMITTER_NAME: 'CPPO',
  GIT_COMMITTER_EMAIL: 'agent-task@localhost',
};

/** For a task built on one that didn't finish: where that run stopped. */
function continuation(pred: Task | undefined): string {
  if (!pred || pred.status === 'done') return '';
  return (
    ` This continues task ${pred.id}, which ended before it finished (${pred.error ?? pred.status}); its changes are already ` +
    'in this copy.' +
    (pred.lastText ? ` Its last message:\n<previous_run>\n${pred.lastText.slice(0, 4000)}\n</previous_run>` : '')
  );
}

/** A Codex `exec --json` event as transcript blocks (completed items carry everything). */
function codexTranscript(ev: CodexEvent): string[] {
  const it = ev.item;
  if (ev.type === 'thread.started') return ['_Codex run started._'];
  if (ev.type === 'turn.completed') {
    const u = ev.usage ?? {};
    return [`_Turn ended: ${(u.input_tokens ?? 0).toLocaleString('en-US')} in (${(u.cached_input_tokens ?? 0).toLocaleString('en-US')} cached) / ${((u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0)).toLocaleString('en-US')} out tokens._`];
  }
  if (ev.type === 'turn.failed') return [`**Failed:** ${ev.error?.message ?? 'the run failed'}`];
  if (ev.type !== 'item.completed' || !it) return [];
  switch (it.type) {
    case 'agent_message':
      return it.text?.trim() ? [it.text.trim()] : [];
    case 'reasoning':
      return it.text?.trim() ? [details('Thinking', fence(clip(it.text.trim(), 4000)))] : [];
    case 'command_execution': {
      const output = it.aggregated_output ?? '';
      const lines = output ? output.split('\n').length : 0;
      return [
        '**Shell**',
        fence(clip(it.command ?? '', 3000), 'sh'),
        details(`${it.exit_code ? `Exit ${it.exit_code}` : 'Result'} · ${lines} line${lines === 1 ? '' : 's'}`, fence(clip(output, 3000))),
      ];
    }
    case 'file_change':
      return [`**Edit** · ${(it.changes ?? []).map((c) => `\`${(c.path ?? '?').replace(/`/g, "'")}\` (${c.kind ?? 'change'})`).join(', ')}`];
    case 'mcp_tool_call':
      return [
        `**${it.server ?? 'mcp'}.${it.tool ?? '?'}**`,
        it.arguments !== undefined ? fence(clip(JSON.stringify(it.arguments, null, 2), 2000), 'json') : '',
        it.result !== undefined ? details('Result', fence(clip(typeof it.result === 'string' ? it.result : JSON.stringify(it.result, null, 2), 3000))) : '',
      ];
    case 'web_search':
      return [`**Web search** · ${it.query ?? ''}`];
    case 'todo_list':
      return [(it.items ?? []).map((x) => `- [${x.completed ? 'x' : ' '}] ${x.text ?? ''}`).join('\n')];
    default:
      return [];
  }
}

/** Google's stream-json log as tool calls, completed agent messages and the result. */
function googleTranscript(ev: AgyEvent, text: Map<number, string>): string[] {
  if (ev.event === 'init') return [`_Google AI run started · ${ev.init?.model ?? '?'} · edit-only._`];
  const step = ev.step_update;
  if (ev.event === 'step_update' && step) {
    const index = step.step_index ?? 0;
    const message = (text.get(index) ?? '') + (step.text_delta ?? '');
    text.set(index, message);
    if (step.step_type === 'agent_response') return step.state === 'DONE' && message.trim() ? [message.trim()] : [];
    if (step.state === 'DONE' && step.step_type === 'tool') {
      return [
        `**${step.tool_name ?? step.tool_info?.name ?? 'tool'}**`,
        fence(clip(JSON.stringify(step.tool_info?.parameters ?? {}, null, 2), 2000), 'json'),
        step.tool_info?.output ? details('Result', fence(clip(step.tool_info.output, 3000))) : '',
      ];
    }
  }
  if (ev.event === 'result') {
    const result = ev.result ?? ev;
    const u = result.usage;
    const denied = deniedOf(ev);
    return [result.response ?? '', `_Run ended: ${result.status ?? '?'} · ${u?.input_tokens ?? 0} in / ${(u?.output_tokens ?? 0) + (u?.thinking_tokens ?? 0)} out tokens._`,
      ...(denied.length ? [`**Refused actions:** ${denied.map(describeDenied).join(', ')}`] : [])];
  }
  return [];
}

/** A tool call's one-line heading in a transcript: what it acts on. */
function toolHead(input: Record<string, unknown>): string {
  const target = input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
  return typeof target === 'string' ? ` · \`${target.replace(/`/g, "'").slice(0, 160)}\`` : '';
}

/** A tool call's input in a transcript: the command, the edit, or the arguments. */
function toolBody(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return fence(clip(input.command, 3000), 'sh');
  if (name === 'Edit' && typeof input.old_string === 'string') {
    const diff = [
      ...String(input.old_string).split('\n').map((l) => `- ${l}`),
      ...String(input.new_string ?? '').split('\n').map((l) => `+ ${l}`),
    ].join('\n');
    return fence(clip(diff, 3000), 'diff');
  }
  if (name === 'Write' && typeof input.content === 'string') return details(`Content · ${input.content.split('\n').length} lines`, fence(clip(input.content, 3000)));
  const rest = { ...input };
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'description']) delete rest[k];
  return Object.keys(rest).length ? fence(clip(JSON.stringify(rest, null, 2), 2000), 'json') : '';
}

const RUN_INSTRUCTIONS =
  "You are a worker agent. You are in a scratch git worktree: a copy of the user's repository, made for this " +
  'task alone. Make the changes the task needs here, and verify them (build, tests) where it makes sense. ' +
  'Do not commit, push, or touch anything outside this directory; paths to the user\'s repository in the task ' +
  "already point at this copy, and nothing outside it is available — if the task needs a file you don't have, " +
  'say so in your report instead of working around it. Dependency folders such as node_modules ' +
  "or .venv may be links to the user's own copies: use them to build and test, but don't install into or " +
  'modify them. Another AI (the lead) will review your ' +
  'changes as a diff before anything reaches the user. Finish with a short report: what you changed and why, ' +
  'what you ran to verify it and the results, and anything left open.';

export class AgentTasks implements vscode.Disposable {
  private readonly tasks = new Map<string, Task>();
  /** Fires when any task changes — the account's status bar item shows them (statusBar.ts). */
  readonly onDidChange = new vscode.EventEmitter<void>();
  /** Above 0 while a saved log is replayed: render() and kill() are held back until it ends. */
  private replaying = 0;

  constructor(
    /** This window's stable identity (its working dir, workdir.ts): only its own tasks are restored to it. */
    private readonly owner: string,
    private readonly spec: (workerId: string) => Promise<AgentRunSpec | undefined>,
    /** The workers server for runs (restricted token), when it is up. */
    private readonly access?: () => { url: string; token: string } | undefined,
    /** Called when a task ends: worker, input and output tokens (for the usage book). */
    private readonly onTaskDone?: (worker: string, inTok: number, outTok: number) => void
  ) {
    this.restore();
    void this.reconcileRestored().catch((err) => log(`agent tasks: restoring after a restart failed — ${(err as Error).message}`));
    this.prune();
  }

  view(id: string): TaskView | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    return {
      id: t.id, worker: t.worker, status: t.status,
      minutes: Math.round(((t.ended ?? Date.now()) - t.started) / 60_000),
      turns: t.turns, lastAction: t.lastAction, files: t.files?.length ?? 0, applied: Boolean(t.applied),
    };
  }

  private root(): string {
    return path.join(workingRoot(), 'agent-tasks');
  }

  // ── Durable state: task.json ─────────────────────────────────────────────────

  /** The task as it goes into task.json — everything but runtime-only fields; no secrets. */
  private stateOf(t: Task): Record<string, unknown> {
    return {
      v: 1,
      id: t.id, owner: t.owner, worker: t.worker, task: t.task, context: t.context, after: t.after, result: t.result,
      status: t.status, repo: t.repo, base: t.base, worktree: t.worktree, started: t.started, ended: t.ended,
      minutes: t.minutes, maxTurns: t.maxTurns, role: t.role, effort: t.effort, runner: t.runner, model: t.model,
      pid: t.pid, supervisor: t.supervisor, links: t.links, snapshotNote: t.snapshotNote, error: t.error,
      cancelling: t.cancelling, applied: t.applied, report: t.report, files: t.files, stat: t.stat,
      sideEffects: t.sideEffects, patchFile: t.patchFile, costUsd: t.costUsd, inTok: t.inTok, outTok: t.outTok,
      turns: t.turns, toolUses: t.toolUses, lastText: t.lastText, lastAction: t.lastAction,
      denied: t.denied, conversationId: t.conversationId,
      google: t.google ? { ctx: t.google.ctx, mcp: t.google.mcp } : undefined,
      written: [...t.written],
    };
  }

  /** task.json, atomically (tmp + rename), 0o600. Written when queued, at launch, on every status change and at finish. */
  private save(t: Task): void {
    const json = JSON.stringify(this.stateOf(t));
    if (json === t.savedJson) return;
    t.savedJson = json;
    try {
      const tmp = path.join(t.dir, `task.json.${process.pid}.tmp`);
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, path.join(t.dir, 'task.json'));
    } catch {
      /* best effort — the in-memory task and log.jsonl are the truth while it runs */
    }
  }

  /** Reads a task dir's task.json; undefined when there is none (pre-restart-survival tasks) or it is unreadable. */
  private readState(dir: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Loads this window's not-too-old tasks from disk, so wait/apply/list see them at once. */
  private restore(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.root());
    } catch {
      return;
    }
    for (const name of names) {
      const dir = path.join(this.root(), name);
      const j = this.readState(dir);
      if (!j) continue;
      // Another window's task, an unknown shape or a task older than KEEP_DAYS: not ours to load.
      if (j.owner !== this.owner) continue;
      const started = typeof j.started === 'number' ? j.started : 0;
      if (Date.now() - started > KEEP_DAYS * 86_400_000) continue;
      const status = (['queued', 'running', 'done', 'failed', 'cancelled'] as const).includes(j.status as Status) ? (j.status as Status) : 'failed';
      if (status === 'queued' || status === 'running') {
        if (typeof j.repo !== 'string' || typeof j.base !== 'string' || typeof j.worktree !== 'string' || typeof j.minutes !== 'number') continue;
      }
      const t: Task = {
        id: typeof j.id === 'string' ? j.id : name,
        owner: this.owner,
        worker: typeof j.worker === 'string' ? j.worker : '?',
        task: typeof j.task === 'string' ? j.task : '',
        context: typeof j.context === 'string' ? j.context : undefined,
        after: typeof j.after === 'string' ? j.after : undefined,
        result: typeof j.result === 'string' ? j.result : undefined,
        status,
        dir, repo: typeof j.repo === 'string' ? j.repo : '',
        base: typeof j.base === 'string' ? j.base : '',
        worktree: typeof j.worktree === 'string' ? j.worktree : '',
        started: started || Date.now(),
        ended: typeof j.ended === 'number' ? j.ended : undefined,
        pid: typeof j.pid === 'number' ? j.pid : undefined,
        supervisor: typeof j.supervisor === 'number' ? j.supervisor : undefined,
        turns: typeof j.turns === 'number' ? j.turns : 0,
        toolUses: typeof j.toolUses === 'number' ? j.toolUses : 0,
        lastAction: typeof j.lastAction === 'string' ? j.lastAction : undefined,
        report: typeof j.report === 'string' ? j.report : undefined,
        error: typeof j.error === 'string' ? j.error : undefined,
        costUsd: typeof j.costUsd === 'number' ? j.costUsd : undefined,
        inTok: typeof j.inTok === 'number' ? j.inTok : undefined,
        outTok: typeof j.outTok === 'number' ? j.outTok : undefined,
        patchFile: typeof j.patchFile === 'string' ? j.patchFile : undefined,
        stat: typeof j.stat === 'string' ? j.stat : undefined,
        files: Array.isArray(j.files) ? j.files.filter((x): x is string => typeof x === 'string') : undefined,
        written: new Set(Array.isArray(j.written) ? j.written.filter((x): x is string => typeof x === 'string') : []),
        sideEffects: Array.isArray(j.sideEffects) ? j.sideEffects.filter((x): x is string => typeof x === 'string') : undefined,
        links: Array.isArray(j.links) ? j.links.filter((x): x is string => typeof x === 'string') : undefined,
        snapshotNote: typeof j.snapshotNote === 'string' ? j.snapshotNote : undefined,
        minutes: typeof j.minutes === 'number' ? j.minutes : TASK_LIMITS.minutes.default,
        maxTurns: typeof j.maxTurns === 'number' ? j.maxTurns : TASK_LIMITS.turns.default,
        lastText: typeof j.lastText === 'string' ? j.lastText : undefined,
        lastOutput: typeof j.lastOutput === 'number' ? j.lastOutput : undefined,
        cancelling: j.cancelling === true,
        runner: typeof j.runner === 'string' && (['claude', 'codex', 'google'] as const).includes(j.runner as 'claude' | 'codex' | 'google') ? (j.runner as Task['runner']) : undefined,
        model: typeof j.model === 'string' ? j.model : undefined,
        google: j.google && typeof j.google === 'object' && (j.google as { ctx?: AgyContext }).ctx
          ? { ctx: (j.google as { ctx: AgyContext; mcp?: boolean }).ctx, mcp: (j.google as { mcp?: boolean }).mcp === true }
          : undefined,
        conversationId: typeof j.conversationId === 'string' ? j.conversationId : undefined,
        denied: Array.isArray(j.denied) ? (j.denied as AgyDenied[]) : undefined,
        googleText: new Map(),
        role: typeof j.role === 'string' ? j.role : undefined,
        effort: typeof j.effort === 'string' ? (j.effort as Effort) : undefined,
        applied: j.applied === true,
        waiters: [],
      };
      t.savedJson = JSON.stringify(this.stateOf(t));
      this.tasks.set(t.id, t);
    }
  }

  /**
   * Brings the restored tasks in step with reality. Finished ones just need
   * their patch checked; queued ones can start now; a running one belongs to
   * another live host (left alone), or is taken over: its log is replayed to
   * rebuild the live counters, then it is watched again — or, if the run has
   * already ended, its result is collected from the worktree it left behind.
   */
  private async reconcileRestored(): Promise<void> {
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') {
        if (t.patchFile && !fs.existsSync(t.patchFile)) {
          t.patchFile = undefined;
          t.result = t.base || t.result;
          this.save(t);
        }
        continue;
      }
      if (t.status === 'queued') continue; // promote() below starts it
      if (!t.pid || !fs.existsSync(t.worktree)) {
        // A task from before runs survived restarts: its worktree went with the old host.
        t.status = 'failed';
        t.error ??= 'its worktree is gone — the extension host stopped before agent tasks survived restarts';
        t.ended = Date.now();
        this.save(t);
        log(`agent task ${t.id}: not re-attached — ${t.error}`);
        continue;
      }
      // Another live host manages it only if that pid is alive AND the run still is — after a reboot a stale
      // supervisor pid can belong to an unrelated process, and nobody else will ever finish a dead run.
      if (t.supervisor && t.supervisor !== process.pid && sessionPids(t.pid).length > 0) {
        try {
          process.kill(t.supervisor, 0);
          continue; // another live host is managing it
        } catch {
          /* that host is gone — take over */
        }
      }
      t.supervisor = process.pid;
      const offset = this.replay(t);
      try {
        t.tail = { fd: fs.openSync(path.join(t.dir, 'log.jsonl'), 'r'), offset, buf: '' };
      } catch {
        t.tail = { fd: -1, offset, buf: '' }; // no log yet; pump tolerates it
      }
      if (sessionPids(t.pid).length > 0) {
        // Still running: re-arm its limits for the time that is left.
        log(`agent task ${t.id}: re-attached after a restart — running, ${t.turns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'} so far`);
        try {
          t.lastOutput = fs.statSync(path.join(t.dir, 'log.jsonl')).mtimeMs; // idle counts from the log, not the restart
        } catch {
          /* no log yet */
        }
        this.armWatchers(t, t.started + t.minutes * 60_000 - Date.now());
        this.watch(t);
      } else {
        log(`agent task ${t.id}: re-attached after a restart — it finished while the window was away`);
        void this.finish(t, null);
      }
      this.save(t);
    }
    await this.promote();
  }

  /**
   * Feeds the whole saved log through the event handlers (render and kill held
   * back) so turns, tool uses, written files, the report and tokens are right
   * again, and returns the log's size in bytes — the tailer starts there.
   */
  private replay(t: Task): number {
    let text = '';
    try {
      text = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf-8');
    } catch {
      /* no log yet */
    }
    this.replaying++;
    try {
      for (const line of text.split('\n')) {
        if (line.trim()) this.onLine(t, line);
      }
      if (t.killPending && t.pid && sessionPids(t.pid).length > 0) {
        t.killPending = undefined;
        this.kill(t); // the run passed a limit while no host was watching
      } else {
        t.killPending = undefined;
      }
    } finally {
      this.replaying--;
    }
    return Buffer.byteLength(text, 'utf-8');
  }

  /** Task folders (patch + log) older than KEEP_DAYS go, with any worktree they still hold. */
  private prune(): void {
    try {
      for (const name of fs.readdirSync(this.root())) {
        const dir = path.join(this.root(), name);
        if (Date.now() - fs.statSync(dir).mtimeMs > KEEP_DAYS * 86_400_000) {
          // A worktree the old dispose() would have removed: take it out of the
          // user's repo before the task dir that names it disappears.
          const j = this.readState(dir);
          const worktree = path.join(dir, 'worktree');
          const repo = typeof j?.repo === 'string' ? j.repo : undefined;
          if (fs.existsSync(worktree) && repo) {
            try {
              execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore', timeout: 60_000 });
            } catch {
              /* best effort — `git worktree prune` will settle the rest */
            }
          }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } catch {
      /* nothing yet */
    }
  }

  private render(): void {
    if (this.replaying > 0) return; // a replayed log paints no intermediate states
    this.onDidChange.fire();
  }

  /**
   * For the account's hover card: how many tasks are active, and a line per
   * recent task (newest first) — worker, state, progress, and what it changed.
   */
  summary(max = 5): { active: number; lines: string[] } {
    const md = (s: string) => s.replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
    const all = [...this.tasks.values()].sort((a, b) => b.started - a.started);
    const active = all.filter((t) => t.status === 'running' || t.status === 'queued').length;
    const lines = all.slice(0, max).map((t) => {
      const name = `[${md(t.worker.split('/').pop() ?? t.worker)}](command:cppo.showAgentTaskTranscript?${encodeURIComponent(JSON.stringify([t.id]))} "Open its transcript")`;
      const what = md(t.task.length > 70 ? `${t.task.slice(0, 70)}…` : t.task);
      const secs = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
      const time = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
      switch (t.status) {
        case 'queued':
          return `$(clock) **${name}** · queued${t.after ? ` after ${t.after}` : ''} — ${what}`;
        case 'running':
          return `$(sync~spin) **${name}** · ${t.turns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'} · ${time}${t.lastAction ? ` · \`${t.lastAction.slice(0, 60).replace(/`/g, "'")}\`` : ''} — ${what}`;
        case 'done':
          return `$(check) **${name}** · done in ${time} · ${t.files?.length ?? 0} file${t.files?.length === 1 ? '' : 's'} changed${t.applied ? ' · **applied**' : t.files?.length ? ' · not applied' : ''} — ${what}`;
        default:
          return t.result && t.files?.length
            ? `$(debug-pause) **${name}** · ${md(t.error ?? t.status)} · ${t.files.length} file${t.files.length === 1 ? '' : 's'} changed${t.applied ? ' · **applied**' : ' · not applied'} — ${what}`
            : `$(error) **${name}** · ${t.status}${t.error ? `: ${md(t.error.slice(0, 80))}` : ''} — ${what}`;
      }
    });
    if (all.length > max) lines.push(`_…and ${all.length - max} earlier_`);
    return { active, lines };
  }

  /** This window's tasks, newest first (the transcript pickers). */
  list(): Array<{ id: string; worker: string; status: Status; task: string; started: number; files: number; applied: boolean }> {
    return [...this.tasks.values()]
      .sort((a, b) => b.started - a.started)
      .map((t) => ({ id: t.id, worker: t.worker, status: t.status, task: t.task, started: t.started, files: t.files?.length ?? 0, applied: Boolean(t.applied) }));
  }

  /**
   * list_tasks: this window's tasks on at most 30 lines — running/queued first
   * (oldest first), then finished newest first — so a lead that lost track of
   * its tasks (a host restart, a reset of its context) finds them again.
   */
  listText(filter?: string): string {
    const all = [...this.tasks.values()].sort((a, b) => a.started - b.started);
    const rows = [
      ...all.filter((t) => t.status === 'running' || t.status === 'queued'),
      ...all.filter((t) => t.status !== 'running' && t.status !== 'queued').sort((a, b) => b.started - a.started),
    ]
      .filter((t) => !filter || t.status === filter)
      .slice(0, 30)
      .map((t) => {
        const steps = t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns';
        const ago = Math.max(0, Math.round((Date.now() - t.started) / 60_000));
        const ended = t.status !== 'running' && t.status !== 'queued';
        const applied = ended && t.files?.length ? (t.applied ? ' · applied' : ' · not applied') : '';
        return `${t.id} · ${t.worker} · ${t.status} · started ${ago} min ago · ${t.turns} ${steps} · ${t.files?.length ?? 0} files${applied} — "${t.task.slice(0, 80).replace(/\s+/g, ' ')}"`;
      });
    if (!rows.length) return filter ? `No ${filter} tasks in this window.` : 'No tasks in this window yet — start_task begins one.';
    return rows.join('\n') + '\n(running: call wait_task; finished and not applied: review with wait_task, then apply_task_changes)';
  }

  /** A task's run as a readable Markdown transcript, from its log; undefined for an unknown task. */
  transcript(id: string): string | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const secs = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
    const out: string[] = [
      `# Agent task ${t.id} · ${t.worker}`,
      [
        `**Status:** ${t.status}${t.applied ? ' (applied)' : ''}`,
        `**Started:** ${new Date(t.started).toLocaleString()} · ${secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`}`,
        t.model ? `**Run by:** ${t.runner === 'google' ? 'Google AI (Antigravity, edit-only)' : t.runner === 'codex' ? 'Codex' : 'Claude Code'} on ${t.model}${t.effort ? `, effort ${t.effort}` : ''}${t.role ? ` · role ${t.role}` : ''}` : '',
        `**Limits:** ${t.minutes} min, ${t.maxTurns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'}`,
        `**${t.runner === 'codex' || t.runner === 'google' ? 'Steps' : 'Turns'}:** ${t.turns} · **tool uses:** ${t.toolUses}${t.inTok !== undefined ? ` · **tokens:** ${t.inTok.toLocaleString('en-US')} in / ${(t.outTok ?? 0).toLocaleString('en-US')} out` : ''}`,
        t.after ? `**Built on:** ${t.after}` : '',
        t.error ? `**Error:** ${t.error}` : '',
      ].filter(Boolean).join('  \n'),
      '## Task',
      fence(t.task),
      t.context ? details('Context', fence(t.context)) : '',
      t.snapshotNote ? `_${t.snapshotNote}_` : '',
      '## Run',
    ];
    let log = '';
    try {
      log = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf-8');
    } catch {
      out.push(t.status === 'queued' ? '_Not started yet._' : '_No log._');
    }
    type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };
    const other: string[] = [];
    const googleText = new Map<number, string>();
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      let ev: { type?: string; subtype?: string; model?: string; permissionMode?: string; claude_code_version?: string; message?: { content?: Block[] | string }; result?: string; num_turns?: number };
      try {
        ev = JSON.parse(line);
      } catch {
        other.push(line);
        continue;
      }
      if (t.runner === 'google') {
        out.push(...googleTranscript(ev as unknown as AgyEvent, googleText));
        continue;
      }
      if (t.runner === 'codex') {
        out.push(...codexTranscript(ev as CodexEvent));
        continue;
      }
      if (ev.type === 'system' && ev.subtype === 'init') {
        out.push(`_Claude Code ${ev.claude_code_version ?? '?'} · ${ev.model ?? '?'} · ${ev.permissionMode ?? '?'} mode_`);
      } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const c of ev.message!.content as Block[]) {
          if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim());
          else if (c.type === 'thinking' && c.thinking?.trim()) out.push(details('Thinking', fence(clip(c.thinking.trim(), 4000))));
          else if (c.type === 'tool_use') out.push(`**${c.name}**${toolHead(c.input ?? {})}`, toolBody(c.name ?? '', c.input ?? {}));
        }
      } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const c of ev.message!.content as Block[]) {
          if (c.type !== 'tool_result') continue;
          const text = typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? (c.content as Block[]).map((x) => (x.type === 'text' ? x.text ?? '' : `[${x.type}]`)).join('\n')
              : '';
          const lines = text.split('\n').length;
          out.push(details(`${c.is_error ? 'Error' : 'Result'} · ${lines} line${lines === 1 ? '' : 's'}`, fence(clip(text, 3000))));
        }
      } else if (ev.type === 'result') {
        out.push(`_Run ended: ${ev.subtype ?? '?'} after ${ev.num_turns ?? '?'} turns._`);
      }
    }
    if (other.length) out.push(details('Other output', fence(clip(other.join('\n'), 3000))));
    if (t.report) out.push('## Report', t.report.trim());
    if (t.stat) out.push('## Changes', fence(t.stat), t.patchFile ? `Patch: \`${t.patchFile}\`` : '');
    if (t.sideEffects?.length) out.push(`_Left out as side effects of commands: ${t.sideEffects.slice(0, 20).join(', ')}${t.sideEffects.length > 20 ? ', …' : ''}_`);
    if (t.status === 'running') out.push('---', '_Still running — this view updates as it goes._');
    return out.filter(Boolean).join('\n\n') + '\n';
  }

  /** The repository a task works on: the window's first folder's git top level. */
  private async repoRoot(): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) throw new Error('This window has no folder open.');
    try {
      return (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new Error(`${folder} is not in a git repository — agent tasks work on a worktree of one.`);
    }
  }

  /** One snapshot at a time per repository: three tasks at once must not triple the work. */
  private readonly snapshotLocks = new Map<string, Promise<unknown>>();

  /**
   * HEAD + uncommitted changes, without touching the user's index: tracked
   * changes (except LFS-managed files) and untracked files within the budgets
   * above (.gitignore respected). Returns the commit and a note of what was left
   * out.
   */
  private async snapshot(repo: string, dir: string, include: string[]): Promise<{ commit: string; note?: string; copied?: string }> {
    const prev = this.snapshotLocks.get(repo) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.snapshotNow(repo, dir, include));
    this.snapshotLocks.set(repo, run);
    try {
      return await run;
    } finally {
      if (this.snapshotLocks.get(repo) === run) this.snapshotLocks.delete(repo);
    }
  }

  private async snapshotNow(repo: string, dir: string, include: string[]): Promise<{ commit: string; note?: string; copied?: string }> {
    const T = { timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS };
    const head = (await git(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
    if (!head) throw new Error('The repository has no commits yet — agent tasks start from one.');
    // Every worktree is a full checkout of HEAD (LFS files stay pointers): refuse a huge one.
    const sizes = await git(repo, ['ls-tree', '-r', '-l', '-z', 'HEAD'], undefined, T);
    let checkout = 0;
    for (const entry of sizes.split('\0')) {
      const n = Number(entry.split(/\s+/)[3]);
      if (Number.isFinite(n)) checkout += n;
    }
    if (checkout > CHECKOUT_MAX_BYTES) {
      throw new Error(`A checkout of this repository's tracked files is ${(checkout / 1024 ** 3).toFixed(1)} GB — too big to copy for an agent task (limit ${CHECKOUT_MAX_BYTES / 1024 ** 3} GB).`);
    }
    const index = path.join(dir, 'index');
    const real = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'index'])).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1', ...IDENTITY };
    const lfs = async (paths: string[]): Promise<Set<string>> => {
      if (paths.length === 0) return new Set();
      const out = await git(repo, ['check-attr', '-z', '--stdin', 'filter'], undefined, { ...T, input: paths.join('\0') + '\0' });
      const parts = out.split('\0');
      const hit = new Set<string>();
      for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === 'lfs') hit.add(parts[i]);
      return hit;
    };
    const addPaths = async (paths: string[], force = false) => {
      for (let i = 0; i < paths.length; i += 500) {
        await git(repo, ['add', '-A', ...(force ? ['-f'] : []), '--pathspec-from-file=-', '--pathspec-file-nul'], env, { ...T, input: paths.slice(i, i + 500).join('\0') });
      }
    };
    const notes: string[] = [];

    // Tracked changes (modified, deleted), minus LFS-managed files.
    const changed = (await gitPaths(repo, ['diff', '--name-only', '-z', 'HEAD'], 100_000)).paths;
    const lfsChanged = await lfs(changed);
    await addPaths(changed.filter((p) => !lfsChanged.has(p)));
    if (lfsChanged.size) notes.push(`${lfsChanged.size} modified Git LFS file(s) (e.g. ${[...lfsChanged][0]}) — the copy has their committed version`);

    // Untracked files, by top-level group (a folder, or a file at the root), smallest
    // groups first, each taken whole or not at all — a scratch folder full of files
    // must not crowd out the few that matter, nor be half-copied.
    const scan = await gitPaths(repo, ['ls-files', '-z', '--others', '--exclude-standard'], UNTRACKED_SCAN_MAX);
    const lfsUntracked = await lfs(scan.paths.slice(0, 20_000));
    const groups = new Map<string, { files: string[]; bytes: number }>();
    let dropped = 0;
    let droppedBytes = 0;
    for (const p of scan.paths) {
      let size = 0;
      try {
        size = fs.lstatSync(path.join(repo, p)).size;
      } catch {
        continue;
      }
      if (lfsUntracked.has(p) || size > UNTRACKED_FILE_MAX) {
        dropped++;
        droppedBytes += size;
        continue;
      }
      const key = p.includes('/') ? `${p.split('/')[0]}/` : p;
      const g = groups.get(key) ?? { files: [], bytes: 0 };
      g.files.push(p);
      g.bytes += size;
      groups.set(key, g);
    }
    const take: string[] = [];
    let total = 0;
    const left: Array<[string, number, number]> = [];
    for (const [key, g] of [...groups.entries()].sort((a, b) => a[1].bytes - b[1].bytes || a[1].files.length - b[1].files.length)) {
      if (total + g.bytes <= UNTRACKED_TOTAL_MAX && take.length + g.files.length <= UNTRACKED_COUNT_MAX) {
        take.push(...g.files);
        total += g.bytes;
      } else {
        left.push([key, g.files.length, g.bytes]);
      }
    }
    await addPaths(take);
    if (dropped || left.length || scan.truncated) {
      const parts: string[] = [];
      if (left.length) {
        parts.push(
          left
            .sort((a, b) => b[2] - a[2])
            .slice(0, 4)
            .map(([k, n, b]) => `${k} (${n.toLocaleString('en-US')} file${n === 1 ? '' : 's'}, ${(b / 1024 ** 2).toFixed(1)} MB)`)
            .join(', ') + (left.length > 4 ? ` and ${left.length - 4} more` : '')
        );
      }
      if (dropped) parts.push(`${dropped} large or LFS file(s), ${(droppedBytes / 1024 ** 3).toFixed(droppedBytes > 1024 ** 3 ? 1 : 3)} GB`);
      if (scan.truncated) parts.push(`and more — over ${UNTRACKED_SCAN_MAX.toLocaleString('en-US')} untracked paths, the rest not looked at`);
      notes.push(
        `untracked ${parts.join('; ')} — over the snapshot budget (${UNTRACKED_FILE_MAX / 1024 ** 2} MB a file, ` +
          `${UNTRACKED_TOTAL_MAX / 1024 ** 2} MB and ${UNTRACKED_COUNT_MAX.toLocaleString('en-US')} files in all); gitignore scratch data to keep it out`
      );
    }
    // Paths asked for by name, gitignored or not: each taken whole within its own budget, or not at all.
    let copied: string | undefined;
    if (include.length) {
      const files: string[] = [];
      let bytes = 0;
      const refused: string[] = [];
      for (const rel of include) {
        const found: string[] = [];
        let size = 0;
        let over = false;
        const walk = (r: string): void => {
          if (over) return;
          const st = fs.lstatSync(path.join(repo, r));
          if (st.isDirectory()) {
            if (path.basename(r) !== '.git') for (const name of fs.readdirSync(path.join(repo, r))) walk(path.join(r, name));
          } else if (st.size > UNTRACKED_FILE_MAX) {
            over = true;
          } else {
            found.push(r.split(path.sep).join('/'));
            size += st.size;
            over = files.length + found.length > INCLUDE_COUNT_MAX || bytes + size > INCLUDE_TOTAL_MAX;
          }
        };
        try {
          walk(rel);
        } catch {
          refused.push(`${rel} (not readable)`);
          continue;
        }
        if (over) refused.push(`${rel} (over the budget)`);
        else {
          files.push(...found);
          bytes += size;
        }
      }
      const lfsIncluded = await lfs(files);
      const take = files.filter((f) => !lfsIncluded.has(f));
      await addPaths(take, true);
      const size = bytes < 1024 ** 2 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
      if (take.length) copied = `Copied in by name: ${take.length} file${take.length === 1 ? '' : 's'}, ${size}`;
      if (lfsIncluded.size) refused.push(`${lfsIncluded.size} Git LFS file(s)`);
      if (refused.length) {
        notes.push(
          `asked-for paths ${refused.join(', ')} — ${UNTRACKED_FILE_MAX / 1024 ** 2} MB a file, ` +
            `${INCLUDE_TOTAL_MAX / 1024 ** 2} MB and ${INCLUDE_COUNT_MAX.toLocaleString('en-US')} files in all; name the files that matter`
        );
      }
    }
    const tree = (await git(repo, ['write-tree'], env, T)).trim();
    const commit = (await git(repo, ['commit-tree', tree, '-p', head, '-m', 'agent task base (HEAD + uncommitted changes)'], env, T)).trim();
    return { commit, note: notes.length ? `Left out of the worker's copy: ${notes.join('; ')}.` : undefined, copied };
  }

  /**
   * Creates a task. With `after`, it builds on that task's result (its tree,
   * not the user's) and waits for it if it is still running; otherwise it starts
   * from a snapshot of the user's repo. Starts at once when a slot is free.
   */
  async start(
    worker: string,
    task: string,
    opts: { context?: string; after?: string; include?: string[]; minutes?: number; maxTurns?: number; role?: string; effort?: Effort } = {}
  ): Promise<{ id: string; queued: boolean; note?: string }> {
    const { context, after, include = [] } = opts;
    const bound = (v: number | undefined, l: { default: number; min: number; max: number }) =>
      Math.round(Math.min(Math.max(Number.isFinite(v) ? v! : l.default, l.min), l.max));
    if (!(await this.spec(worker))) throw new Error(`"${worker}" is not enabled for agent tasks.`);
    if (after && include.length) throw new Error('`include` is for tasks that start from the repo; a chained task has what the task before it had.');
    let pred: Task | undefined;
    if (after) {
      pred = this.tasks.get(after);
      if (!pred) throw new Error(this.unknownId(after));
      if ((pred.status === 'failed' || pred.status === 'cancelled') && !pred.result) throw new Error(`Task ${after} ${pred.status} before it changed anything — nothing to build on.`);
    }
    const id = `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const dir = path.join(this.root(), id);
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true, mode: 0o700 });
    const repo = pred ? pred.repo : await this.repoRoot();
    const t: Task = {
      id, owner: this.owner, worker, task, context, after, status: 'queued', dir, repo, base: '', worktree: path.join(dir, 'worktree'),
      started: Date.now(), turns: 0, toolUses: 0, written: new Set(), waiters: [],
      minutes: bound(opts.minutes, TASK_LIMITS.minutes), maxTurns: bound(opts.maxTurns, TASK_LIMITS.turns),
      role: opts.role, effort: opts.effort,
    };
    const notes: string[] = [];
    const refused: string[] = [];
    if (!pred) {
      // Asked for by name, plus files the task names by absolute path (often gitignored scratch).
      const wanted = new Set<string>();
      for (const entry of include) {
        const rel = path.relative(repo, path.resolve(repo, entry));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refused.push(`${entry} (outside the repository)`);
        else if (!fs.existsSync(path.join(repo, rel))) refused.push(`${entry} (not found)`);
        else wanted.add(rel);
      }
      for (const rel of mentionedFiles(repo, `${task}\n${context ?? ''}`)) wanted.add(rel);
      const snap = await this.snapshot(repo, dir, [...wanted]);
      t.base = snap.commit;
      t.snapshotNote = snap.note;
      if (refused.length) notes.push(`Not copied: ${refused.join(', ')}.`);
      if (snap.copied) notes.push(`${snap.copied}.`);
      if (snap.note) {
        notes.push(snap.note);
        log(`agent task ${id}: ${snap.note}`);
      }
    } else {
      t.snapshotNote = pred.snapshotNote;
    }
    this.tasks.set(id, t);
    this.save(t);
    log(`agent task ${id}: queued on ${worker}${after ? ` after ${after}` : ''}`);
    await this.promote();
    return { id, queued: t.status === 'queued', note: notes.length ? notes.join(' ') : undefined };
  }

  /** Starts queued tasks whose predecessor is done, while slots are free; fails those whose predecessor didn't finish. */
  private async promote(): Promise<void> {
    for (const t of [...this.tasks.values()].filter((x) => x.status === 'queued').sort((a, b) => a.started - b.started)) {
      const pred = t.after ? this.tasks.get(t.after) : undefined;
      // A predecessor stopped at a limit still has its changes (result): build on them.
      if (pred && (pred.status === 'failed' || pred.status === 'cancelled') && !pred.result) {
        t.status = 'failed';
        t.error = `its predecessor ${pred.id} ${pred.status}`;
        t.ended = Date.now();
        this.save(t);
        for (const w of t.waiters.splice(0)) w();
        continue;
      }
      if (pred && (pred.status === 'running' || pred.status === 'queued')) continue;
      if ([...this.tasks.values()].filter((x) => x.status === 'running').length >= MAX_RUNNING) return;
      if (pred) t.base = pred.result ?? pred.base;
      try {
        await this.launch(t);
      } catch (err) {
        if (t.google?.mcp) removeAgyMcpConfig(t.worktree);
        t.status = 'failed';
        t.error = (err as Error).message;
        t.ended = Date.now();
        this.save(t);
        log(`agent task ${t.id}: could not start — ${t.error}`);
        for (const w of t.waiters.splice(0)) w();
      }
    }
    this.render();
  }

  private async launch(t: Task): Promise<void> {
    const spec = await this.spec(t.worker);
    if (!spec) throw new Error(`"${t.worker}" is no longer enabled for agent tasks.`);
    const config = path.join(t.dir, 'config');
    // LFS files stay pointers: a checkout must not copy their content (10,861 of them in one repo).
    await git(t.repo, ['worktree', 'add', '--detach', t.worktree, t.base], { GIT_LFS_SKIP_SMUDGE: '1' }, { timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS });
    t.links = [];
    for (const name of DEP_DIRS) {
      const from = path.join(t.repo, name);
      const to = path.join(t.worktree, name);
      try {
        if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue;
        await git(t.repo, ['check-ignore', '-q', name]); // throws unless ignored
        fs.symlinkSync(from, to, 'dir');
        t.links.push(name);
      } catch {
        /* not there, not ignored, or not linkable */
      }
    }
    if (t.links.length) log(`agent task ${t.id}: linked ${t.links.join(', ')} from the repo`);
    t.runner = spec.runner === 'google' && spec.google ? 'google' : spec.runner === 'codex' && spec.codex ? 'codex' : 'claude';
    t.model = spec.runModel;
    // Workers can consult: the workers server with the restricted token (delegate, list_workers, provider_usage).
    // Known limitation, accepted: a run re-adopted after a host restart may hold a consult connection whose
    // URL/token (baked into its run config) belonged to the OLD host's server — the new host's server has a new
    // port and token. Consults then fail inside the agent and it carries on; the lead replaces that separately.
    let access = this.access?.();
    if (t.runner === 'google') {
      const mcp = access ? writeAgyMcpConfig(t.worktree, access.url, access.token).created : false;
      t.google = { ctx: spec.google!.ctx, mcp };
      if (!mcp) access = undefined;
    }
    if (t.runner === 'claude') {
      fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(spec.settings, null, 2), { mode: 0o600 });
      fs.writeFileSync(
        path.join(config, '.claude.json'),
        JSON.stringify({
          hasCompletedOnboarding: true,
          projects: { [t.worktree]: { hasTrustDialogAccepted: true } },
          ...(spec.approveKeyTail && { customApiKeyResponses: { approved: [spec.approveKeyTail], rejected: [] } }),
          ...(access && {
            mcpServers: {
              [CONSULT_SERVER]: { type: 'http', url: access.url, headers: { Authorization: `Bearer ${access.token}` }, timeout: MCP_CALL_TIMEOUT_MS },
            },
          }),
        }),
        { mode: 0o600 }
      );
    }
    t.status = 'running';
    t.started = Date.now();
    // The lead names files by their real paths; the worker must read and edit its copy.
    const repoPath = new RegExp(`${escapeRegExp(t.repo)}(?=[/\\s\`'")\\]]|$)`, 'g');
    const local = (s: string) => s.replace(repoPath, t.worktree);
    const prompt =
      `${RUN_INSTRUCTIONS}${access ? CONSULT_INSTRUCTIONS : ''}` +
      (t.runner === 'google' ? ' You cannot run shell commands in this run (they are refused). Edit files only; do not try to build or test — say in your report which checks the lead should run.' : '') +
      ' Git LFS files in this copy are pointer files, not their content.' +
      (t.snapshotNote ? ` ${t.snapshotNote}` : '') +
      ` You have ${t.minutes} minutes and ${t.maxTurns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'}. Your changes so far are kept if you run out, ` +
      'but your report is not: if you might, stop in time and report what is done and what is left.' +
      continuation(t.after ? this.tasks.get(t.after) : undefined) +
      (t.role === '2d-art' && t.runner === 'google'
        ? " Generate each image with your image generation tool. The image tool saves its files in its own folder, outside this worktree, and you can't copy them — they are collected for you afterwards: give each image a descriptive name and list the names (and what each shows) in your report."
        : t.role === '2d-art'
        ? ' Generate the images with your image generation tool, then save each one as a file in this worktree — at ' +
          'the path the task gives, else under assets/generated/ — and list the paths in your report.'
        : '') +
      `\n\n<task>\n${local(t.task)}\n</task>` +
      (t.context ? `\n\n<context>\n${local(t.context)}\n</context>` : '');
    // The run is detached (its own session) with its stream going straight into
    // log.jsonl — no pipe that a host exit would break — and wrapped in a hard
    // wall (proc.ts LIMIT_SNIPPET) so it ends at its limit even with no host
    // watching. This host then only TAILS the log.
    const logFd = fs.openSync(path.join(t.dir, 'log.jsonl'), 'a', 0o600);
    t.lastOutput = Date.now();
    let child: ChildProcess;
    try {
      child =
        t.runner === 'google' ? await this.spawnGoogle(t, spec.google!, spec.runModel, prompt, logFd) :
        t.runner === 'codex' ? this.spawnCodex(t, spec.codex!, spec.runModel, prompt, access, logFd) :
        this.spawnClaude(t, spec, prompt, access, config, logFd);
    } catch (err) {
      fs.closeSync(logFd);
      throw err;
    }
    fs.closeSync(logFd); // the child holds its own duplicates
    t.child = child;
    t.pid = child.pid;
    t.supervisor = process.pid;
    child.unref(); // the run must outlive this host
    child.on('error', (err) => {
      t.error = err.message;
      this.save(t);
    });
    child.on('close', (code) => {
      this.pumpFinal(t);
      this.stopWatchers(t);
      void this.finish(t, code);
    });
    t.tail = { fd: fs.openSync(path.join(t.dir, 'log.jsonl'), 'r'), offset: 0, buf: '' };
    this.armWatchers(t, t.minutes * 60_000);
    this.watch(t);
    this.save(t);
    log(`agent task ${t.id}: started on ${t.worker} (${t.runner === 'google' ? 'Google AI (Antigravity, edit-only)' : t.runner === 'codex' ? 'Codex' : 'Claude Code'}, ${spec.runModel}) in ${t.worktree}`);
    this.render();
  }

  /** The wall clock and the idle watcher. `remainMs <= 0` — a re-adopted task already past its limit — ends the run now. */
  private armWatchers(t: Task, remainMs: number): void {
    if (remainMs <= 0) {
      t.error ??= `stopped at its ${t.minutes}-minute limit`;
      this.save(t);
      this.kill(t);
      return;
    }
    t.wall = setTimeout(() => {
      t.error ??= `stopped at its ${t.minutes}-minute limit`;
      this.save(t);
      this.kill(t);
    }, remainMs);
    t.idle = setInterval(() => {
      if (Date.now() - (t.lastOutput ?? t.started) < IDLE_MS) return;
      t.error ??= `stopped: no output for ${IDLE_MS / 60_000} minutes`;
      this.save(t);
      this.kill(t);
    }, 60_000);
  }

  /** The log tailer (500 ms) and, for a run this host didn't spawn, the liveness poll (1 s). */
  private watch(t: Task): void {
    if (!t.tail) return;
    t.tail.timer ??= setInterval(() => this.pump(t), 500);
    if (!t.child && t.pid) {
      t.poll ??= setInterval(() => {
        if (sessionPids(t.pid!).length > 0) return;
        this.pumpFinal(t);
        this.stopWatchers(t);
        void this.finish(t, null); // how it ended is in the log, not an exit code
      }, 1000);
    }
  }

  /** Reads whatever new bytes landed in log.jsonl and feeds complete lines to the event handlers. */
  private pump(t: Task): void {
    const tail = t.tail;
    if (!tail) return;
    let size = 0;
    try {
      size = fs.fstatSync(tail.fd).size;
    } catch {
      return;
    }
    if (size <= tail.offset) return;
    const fresh = Buffer.alloc(size - tail.offset);
    try {
      fs.readSync(tail.fd, fresh, 0, fresh.length, tail.offset);
    } catch {
      return;
    }
    tail.offset += fresh.length;
    t.lastOutput = Date.now();
    tail.buf += fresh.toString();
    let nl: number;
    while ((nl = tail.buf.indexOf('\n')) >= 0) {
      this.onLine(t, tail.buf.slice(0, nl));
      tail.buf = tail.buf.slice(nl + 1);
    }
    this.save(t); // counters, report and errors trail the log by at most one poll
  }

  /** The last pump, then a trailing line without its newline. */
  private pumpFinal(t: Task): void {
    this.pump(t);
    if (t.tail?.buf.trim()) this.onLine(t, t.tail.buf);
    if (t.tail) t.tail.buf = '';
  }

  private onLine(t: Task, line: string): void {
    if (t.runner === 'google') this.onGoogleEvent(t, line);
    else if (t.runner === 'codex') this.onCodexEvent(t, line);
    else this.onEvent(t, line);
  }

  private stopWatchers(t: Task): void {
    if (t.wall) clearTimeout(t.wall);
    t.wall = undefined;
    if (t.idle) clearInterval(t.idle);
    t.idle = undefined;
    if (t.tail?.timer) clearInterval(t.tail.timer);
    if (t.tail) {
      try {
        fs.closeSync(t.tail.fd);
      } catch {
        /* already closed */
      }
      t.tail = undefined;
    }
    if (t.poll) clearInterval(t.poll);
    t.poll = undefined;
  }

  /** Claude Code on the worker's provider: its own config dir, auto mode, stream-json. Detached, into log.jsonl. */
  private spawnClaude(t: Task, spec: AgentRunSpec, prompt: string, access: { url: string; token: string } | undefined, config: string, logFd: number): ChildProcess {
    const args = [
      '-p', prompt, '--model', spec.runModel, '--permission-mode', 'auto',
      ...(t.effort ? ['--effort', t.effort] : []),
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', String(t.maxTurns),
      // Consulting is answers-only and already consented to: no classifier check per call.
      ...(access ? ['--allowedTools', ...CONSULT_TOOLS.map((n) => `mcp__${CONSULT_SERVER}__${n}`)] : []),
    ];
    // Only the run's own config and provider: none of this window's account or provider leaks in.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];
    Object.assign(env, spec.secretEnv, { CLAUDE_CONFIG_DIR: config, PYTHONDONTWRITEBYTECODE: '1', CPPO_LIMIT_S: String(t.minutes * 60 + 120) });
    // The Claude Code extension's binary, through a login shell (see cli.ts).
    return spawn(process.env.SHELL || '/bin/bash', claudeShellArgs(args, t.minutes * 60 + 120), {
      cwd: t.worktree,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  }

  /**
   * Codex itself on its model: `codex exec` in the worktree, its sandbox limited
   * to writing there (no network for commands), approval requests reviewed
   * automatically, the user's Codex config and rules not loaded (its sign-in
   * still is), nothing kept on disk. The workers server comes in as an MCP server
   * with the restricted token, from the environment. The prompt — on stdin
   * before, which would tie the run to this host — goes in through
   * <dir>/prompt.txt, deleted once the run ends. Detached, into log.jsonl.
   */
  private spawnCodex(t: Task, ctx: CodexContext, model: string, prompt: string, access: { url: string; token: string } | undefined, logFd: number): ChildProcess {
    const mcp = `mcp_servers.${CONSULT_SERVER}`;
    const args = [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      // --approve-for-me is the workspace-write sandbox with automatic review (it refuses --sandbox alongside).
      '--approve-for-me', '-m', model, '-C', t.worktree,
      ...(t.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(clampEffort(t.effort, ctx.efforts?.[model]))}`] : []),
      ...AGENT_DISABLED.flatMap((f) => ['--disable', f]),
      ...(access
        ? ['-c', `${mcp}.url=${JSON.stringify(access.url)}`, '-c', `${mcp}.bearer_token_env_var="CPPO_WORKERS_TOKEN"`, '-c', `${mcp}.tool_timeout_sec=${Math.floor(MCP_CALL_TIMEOUT_MS / 1000)}`]
        : []),
      '-',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CONFIG_DIR' || k === 'OPENAI_API_KEY' || k === 'CODEX_API_KEY') delete env[k];
    Object.assign(env, ctx.env, { CODEX_HOME: ctx.home, PYTHONDONTWRITEBYTECODE: '1', CPPO_LIMIT_S: String(t.minutes * 60 + 120) }, access ? { CPPO_WORKERS_TOKEN: access.token } : {});
    const promptFile = path.join(t.dir, 'prompt.txt');
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const inFd = fs.openSync(promptFile, 'r');
    try {
      return spawn(process.env.SHELL || '/bin/bash', codexShellArgs(ctx.bin, args, t.minutes * 60 + 120), { cwd: t.worktree, env, detached: true, stdio: [inFd, logFd, logFd] });
    } finally {
      fs.closeSync(inFd); // the child holds its own duplicate
    }
  }

  /**
   * agy edits workspace files only; shell and URL actions are always refused.
   * Through the same /bin/sh limit trampoline as the other runners, detached,
   * into log.jsonl.
   */
  private async spawnGoogle(t: Task, google: NonNullable<AgentRunSpec['google']>, modelId: string, prompt: string, logFd: number): Promise<ChildProcess> {
    const model = google.models.find((m) => m.id === modelId);
    if (!model) throw new Error(`Google AI model ${modelId} isn't available`);
    const env = await agyRunEnv(google.ctx, { CPPO_LIMIT_S: String(t.minutes * 60 + 120) });
    const files = agyPromptArgs(prompt);
    try {
      const child = spawn('/bin/sh', ['-c', LIMIT_SNIPPET, google.ctx.bin, ...agyAgentArgs({
        slug: agySlug(model, t.effort), settings: agyPermissions(t.google?.mcp ? { mcpServer: CONSULT_SERVER } : undefined),
        promptArgs: files.args, timeoutSec: t.minutes * 60,
      })], { cwd: t.worktree, env, detached: true, stdio: ['ignore', logFd, logFd] });
      child.on('close', () => files.cleanup());
      return child;
    } catch (err) {
      files.cleanup();
      throw err;
    }
  }

  private onGoogleEvent(t: Task, line: string): void {
    const ev = parseAgyLine(line);
    if (!ev) return;
    const step = ev.step_update;
    t.conversationId = ev.conversation_id ?? ev.result?.conversation_id ?? step?.conversation_id ?? t.conversationId;
    if (ev.event === 'init') {
      t.model = ev.init?.model ?? t.model;
      t.conversationId = (ev.init as { conversation_id?: string } | undefined)?.conversation_id ?? t.conversationId;
    }
    if (ev.event === 'step_update' && step) {
      if (step.step_type === 'agent_response') {
        t.googleText ??= new Map();
        const index = step.step_index ?? 0;
        const text = (t.googleText.get(index) ?? '') + (step.text_delta ?? '');
        t.googleText.set(index, text);
        if (step.state === 'DONE') t.lastText = text;
      }
      if (step.state === 'DONE' && step.step_type === 'tool') {
        t.toolUses++;
        t.turns++;
        const name = step.tool_name ?? step.tool_info?.name ?? 'tool';
        const params = step.tool_info?.parameters ?? {};
        const arg = Object.values(params).find((v) => typeof v === 'string');
        t.lastAction = `${name} ${typeof arg === 'string' ? arg.slice(0, 80) : ''}`.trim();
        if (/write|edit|replace|create/i.test(name)) {
          for (const [key, value] of Object.entries(params)) {
            if (typeof value !== 'string' || !/path|file/i.test(key)) continue;
            const rel = path.relative(t.worktree, path.resolve(t.worktree, value));
            if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) t.written.add(rel.split(path.sep).join('/'));
          }
        }
        if (t.turns > t.maxTurns && !t.error) {
          t.error = `stopped at its ${t.maxTurns}-step limit`;
          this.kill(t);
        }
      }
      this.render();
    }
    if (ev.event === 'result') {
      const result = ev.result ?? ev;
      t.googleResult = true;
      t.sawResult = true;
      t.report = result.response;
      t.inTok = result.usage?.input_tokens;
      t.outTok = result.usage ? (result.usage.output_tokens ?? 0) + (result.usage.thinking_tokens ?? 0) : undefined;
      t.denied = deniedOf(ev);
      if (result.status !== 'SUCCESS' && !t.error) t.error = `Google AI run failed: ${result.status ?? 'unknown status'}`;
    }
  }

  /** Codex's `exec --json` events: items (messages, commands, file changes, MCP calls) and turn usage. */
  private onCodexEvent(t: Task, line: string): void {
    let ev: CodexEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const it = ev.item;
    if (ev.type === 'item.started' && it) {
      if (it.type === 'command_execution' && it.command) t.lastAction = `$ ${it.command.slice(0, 80)}`;
      else if (it.type === 'mcp_tool_call') t.lastAction = `${it.server ?? 'mcp'}.${it.tool ?? '?'}`;
      this.render();
    } else if (ev.type === 'item.completed' && it) {
      t.turns++;
      if (it.type === 'agent_message' && it.text?.trim()) t.lastText = it.text.trim();
      if (it.type === 'command_execution' || it.type === 'mcp_tool_call') t.toolUses++;
      if (it.type === 'file_change') {
        t.toolUses++;
        const files: string[] = [];
        for (const c of it.changes ?? []) {
          if (!c.path) continue;
          const rel = path.relative(t.worktree, path.resolve(t.worktree, c.path));
          if (rel.startsWith('..')) continue;
          files.push(rel.split(path.sep).join('/'));
          if (c.kind !== 'delete') t.written.add(rel.split(path.sep).join('/'));
        }
        t.lastAction = `edit ${files.join(', ').slice(0, 80)}`;
      }
      if (t.turns > t.maxTurns && !t.error) {
        t.error = `stopped at its ${t.maxTurns}-step limit`;
        this.kill(t);
      }
      this.render();
    } else if (ev.type === 'turn.completed') {
      t.sawResult = true;
      t.inTok = (t.inTok ?? 0) + (ev.usage?.input_tokens ?? 0);
      t.outTok = (t.outTok ?? 0) + (ev.usage?.output_tokens ?? 0) + (ev.usage?.reasoning_output_tokens ?? 0);
      t.report = t.lastText;
    } else if (ev.type === 'turn.failed' && !t.error) {
      // `error` events are often retries ("Reconnecting... 2/5"); a failed turn is final.
      t.error = ev.error?.message ?? 'the run failed';
    }
  }

  private onEvent(t: Task, line: string): void {
    let ev: { type?: string; subtype?: string; permissionMode?: string; claude_code_version?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> }; result?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.permissionMode !== 'auto') {
      // Headless, nobody can approve anything: outside auto mode every edit is denied
      // and the run only burns turns. Some versions fall back to "default" quietly.
      t.error =
        `Claude Code ${ev.claude_code_version ?? '(unknown version)'} started the run in "${ev.permissionMode ?? '?'}" ` +
        'permission mode, not auto, so it could not edit anything. Update Claude Code (the Claude Code extension, ' +
        "or the `claude` on PATH where that extension isn't installed).";
      log(`agent task ${t.id}: ${t.error}`);
      this.kill(t);
      return;
    }
    if (ev.type === 'assistant') {
      t.turns++;
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) t.lastText = c.text.trim();
        if (c.type === 'tool_use') {
          t.toolUses++;
          const arg = c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? '';
          t.lastAction = `${c.name} ${String(arg).slice(0, 80)}`.trim();
          const file = c.input?.file_path ?? c.input?.notebook_path;
          if (typeof file === 'string' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name ?? '')) {
            const rel = path.relative(t.worktree, path.resolve(t.worktree, file));
            if (!rel.startsWith('..')) t.written.add(rel.split(path.sep).join('/'));
          }
        }
      }
      this.render();
    } else if (ev.type === 'result') {
      t.sawResult = true;
      t.report = ev.result;
      t.costUsd = ev.total_cost_usd;
      t.inTok = ev.usage?.input_tokens;
      t.outTok = ev.usage?.output_tokens;
      if (ev.subtype === 'error_max_turns' && !t.error) t.error = `stopped at its ${t.maxTurns}-turn limit`;
      if (ev.is_error && !t.error) t.error = 'the run ended with an error';
    }
  }

  private async finish(t: Task, code: number | null): Promise<void> {
    this.stopWatchers(t);
    fs.rmSync(path.join(t.dir, 'prompt.txt'), { force: true }); // the run's prompt (Codex stdin), no longer needed
    // The dependency links go first: they're the user's folders, never the task's changes.
    for (const name of t.links ?? []) {
      try {
        const link = path.join(t.worktree, name);
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {
        /* already gone */
      }
    }
    try {
      if (t.runner === 'google') {
        if (t.google?.mcp) removeAgyMcpConfig(t.worktree);
        // `code === null` means this host never saw the process end (a re-adopted
        // run): success is then decided by the log's own terminal event below.
        if (code === 0 && !t.googleResult && !t.error) t.error = 'Google AI ended without a result';
        if (t.role === '2d-art' && t.google && t.conversationId) {
          const copied: string[] = [];
          for (const file of collectAgyImages(t.google.ctx.home, t.conversationId, t.started - 5000)) {
            const rel = `assets/generated/${path.basename(file)}`;
            const dest = path.join(t.worktree, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try { fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); }
            catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; throw err; }
            copied.push(rel);
            t.written.add(rel);
          }
          if (copied.length) t.report = `${t.report ?? ''}\n\nCollected images: ${copied.join(', ')}.\nGoogle AI's image tool returns 1024×1024 JPEGs and can't make real transparency (any checkerboard is painted into the picture) — resize/cut out as needed.`;
        }
      }
      await git(t.worktree, ['add', '-A']);
      // Changes to files that existed land; new files only if the worker wrote
      // them with its file tools — a cache or build output from its own checks
      // (e.g. __pycache__) is reported, not applied.
      const status = (await git(t.worktree, ['diff', '--cached', '--name-status', '--no-renames', t.base])).trim().split('\n').filter(Boolean);
      const included: string[] = [];
      t.sideEffects = [];
      for (const line of status) {
        const [code, file] = line.split('\t');
        // 2D art: images come from the image tool and get copied in by command — they ARE the work.
        const art = t.role === '2d-art' && /\.(png|jpe?g|webp|gif|svg)$/i.test(file);
        // Codex creates most files with shell heredocs and redirects, which never show up as edits — a
        // new source file it made that way is the work (a task lost its whole new module this way). Its
        // build output and caches are gitignored or match CACHE_LIKE; everything else new is kept.
        // Google's edit-only runner also keeps new files: its tools may use unrecognized path parameters.
        const shellMade = (t.runner === 'codex' || t.runner === 'google') && !CACHE_LIKE.test(file);
        if (code === 'A' && !t.written.has(file) && !art && !shellMade) t.sideEffects.push(file);
        else included.push(file);
      }
      t.files = included;
      const spec = included.length > 0 ? ['--', ...included] : null;
      const patch = spec ? await git(t.worktree, ['diff', '--cached', '--binary', '--no-renames', t.base, ...spec]) : '';
      t.stat = spec ? (await git(t.worktree, ['diff', '--cached', '--stat', '--no-renames', t.base, ...spec])).trim() : '';
      if (patch.trim()) {
        t.patchFile = path.join(t.dir, 'changes.patch');
        fs.writeFileSync(t.patchFile, patch, { mode: 0o600 });
        // The result as a commit (base + included changes only), for tasks chained after this one.
        const index = path.join(t.dir, 'result-index');
        const env = { GIT_INDEX_FILE: index, ...IDENTITY };
        await git(t.repo, ['read-tree', t.base], env);
        await git(t.repo, ['apply', '--cached', '--binary', t.patchFile], env);
        const tree = (await git(t.repo, ['write-tree'], env)).trim();
        t.result = (await git(t.repo, ['commit-tree', tree, '-p', t.base, '-m', `agent task ${t.id} result`], env)).trim();
        fs.rmSync(index, { force: true });
      } else {
        t.result = t.base;
      }
    } catch (err) {
      t.error = t.error ?? `collecting changes failed: ${(err as Error).message}`;
    }
    if (t.denied?.length) {
      if (t.files?.length === 0 && !t.report?.trim() && !t.error) t.error = "Google AI tried an action it isn't allowed to and changed nothing";
      t.report = `${t.report ?? ''}\n\n**Incomplete work notice:** Google AI was refused ${t.denied.length} action(s) it tried (${t.denied.map(describeDenied).join(', ')}): the work may be incomplete.`;
    }
    try {
      await git(t.repo, ['worktree', 'remove', '--force', t.worktree]);
    } catch (err) {
      log(`agent task ${t.id}: worktree removal failed — ${(err as Error).message}`);
    }
    fs.rmSync(path.join(t.dir, 'config'), { recursive: true, force: true }); // the run's settings
    fs.rmSync(path.join(t.dir, 'index'), { force: true });
    // With no exit code of our own (this host re-adopted the run), the log decides:
    // the runner's own terminal event, or at least a report, counts as success.
    if (code === null && !t.error && !t.report && !t.sawResult) t.error = 'the run ended without reporting';
    if (t.status === 'running') {
      const ok = !t.error && (code === 0 || Boolean(t.report) || (code === null && t.sawResult));
      t.status = t.cancelling ? 'cancelled' : ok ? 'done' : 'failed';
    }
    t.ended = Date.now();
    t.child = undefined;
    log(`agent task ${t.id}: ${t.status}${t.error && t.status !== 'done' ? ` (${t.error})` : ''} in ${Math.round((t.ended - t.started) / 1000)} s, ${t.turns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'}, ${t.files?.length ?? 0} files changed`);
    this.save(t);
    this.onTaskDone?.(t.worker, t.inTok ?? 0, t.outTok ?? 0);
    this.render();
    for (const w of t.waiters.splice(0)) w();
    await this.promote(); // a slot is free, and tasks chained on this one may start
  }

  /**
   * Ends a run: SIGTERM to every process in its session, then SIGKILL five
   * seconds later if any survived (a tool may trap TERM). The session — not the
   * leader's process group — because `timeout` moves the runner to a group of
   * its own and a shell command may spawn further groups or sessions.
   */
  private kill(t: Task): void {
    if (this.replaying > 0) {
      t.killPending = true; // the log is history, not now; act on it after the replay
      return;
    }
    const pid = t.pid ?? t.child?.pid;
    if (!pid) return;
    killSession(pid, 'SIGTERM');
    setTimeout(() => {
      if (sessionPids(pid).length > 0) killSession(pid, 'SIGKILL');
    }, 5000);
  }

  cancel(id: string): string {
    const t = this.tasks.get(id);
    if (!t) return `No task ${id}.`;
    if (t.status === 'queued') {
      t.status = 'cancelled';
      t.ended = Date.now();
      this.save(t);
      for (const w of t.waiters.splice(0)) w();
      void this.promote(); // tasks chained on it fail now
      return `Cancelled ${id} before it started.`;
    }
    if (t.status !== 'running') return `Task ${id} already ${t.status}.`;
    // Stays "running" until finish() has collected the changes, so wait_task waits for them.
    t.cancelling = true;
    t.error ??= 'stopped by the lead';
    this.save(t);
    this.kill(t);
    return `Cancelling ${id}; its changes so far are still collected.`;
  }

  /** Why an unknown id is unknown — and where to look instead. */
  private unknownId(id: string): string {
    const dir = path.join(this.root(), id);
    if (fs.existsSync(dir)) {
      const j = this.readState(dir);
      if (j) {
        if (typeof j.owner === 'string' && j.owner !== this.owner) return `Task ${id} belongs to another VS Code window. Call list_tasks for this window's tasks.`;
      } else {
        return `Task ${id} was started by an older CPPO and lost when its window restarted (its log is in ${dir}). Call list_tasks for this window's tasks.`;
      }
    }
    return `Task ${id} isn't known to this window (it may be from another window, or older than ${KEEP_DAYS} days). Call list_tasks for this window's tasks.`;
  }

  /** Waits up to `seconds` for the task to end; then reports where it is. */
  async wait(id: string, seconds: number): Promise<{ text: string; isError?: boolean }> {
    const t = this.tasks.get(id);
    if (!t) return { text: this.unknownId(id), isError: true };
    if (t.status === 'running' || t.status === 'queued') {
      await new Promise<void>((resolve) => {
        // At most 240 s: the whole MCP call must end inside Claude Code's 5-minute idle limit.
        const timer = setTimeout(resolve, Math.min(Math.max(seconds, 1), 240) * 1000);
        t.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const secs = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
    if (t.status === 'queued') {
      return { text: `Task ${id} is queued${t.after ? ` — it starts when ${t.after} is done` : ' — waiting for a free slot'} — call wait_task again now.` };
    }
    if (t.status === 'running') {
      return { text: `Task ${id} is still running (${secs} s, ${t.turns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'}, ${t.toolUses} tool calls; last: ${t.lastAction ?? '—'}). Still running — call wait_task again now; don't report to the user yet.` };
    }
    let diff = '';
    if (t.patchFile) {
      const full = fs.readFileSync(t.patchFile, 'utf-8');
      diff = full.length > MAX_DIFF_IN_RESULT ? `${full.slice(0, MAX_DIFF_IN_RESULT)}\n… (truncated — full patch: ${t.patchFile})` : full;
    }
    const stopped = t.status !== 'done' && Boolean(t.result);
    return {
      text: [
        `Task ${id}: ${t.status}${t.error ? ` (${t.error})` : ''} — ${t.worker}, ${secs} s, ${t.turns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'}${t.costUsd !== undefined ? `, ~$${t.costUsd.toFixed(3)} by Claude Code's estimate` : ''}.` +
          (t.after ? ` Built on ${t.after}.` : '') +
          (t.snapshotNote ? `\n${t.snapshotNote}` : ''),
        `\nWorker's report:\n${t.report ?? '(none)'}`,
        t.patchFile
          ? `\nChanges (against ${t.after ? `the result of ${t.after}` : "HEAD + the user's uncommitted changes at start"}):\n${t.stat}\n\n${diff}`
          : '\nNo file changes.',
        t.sideEffects?.length
          ? `\nCreated by commands, NOT included (build output, caches…): ${t.sideEffects.slice(0, 20).join(', ')}${t.sideEffects.length > 20 ? ` and ${t.sideEffects.length - 20} more` : ''}.`
          : '',
        stopped && !t.report && t.lastText ? `\nIts last message before it was stopped:\n${t.lastText.slice(0, 3000)}` : '',
        t.patchFile ? `\nReview the diff; if it should land, call apply_task_changes with task_id "${id}".` : '',
        stopped
          ? `\nIt didn't finish, but its changes so far are kept: apply them, or continue with start_task and after: "${id}" ` +
            '(the follow-up starts from them and is told where this run stopped).'
          : '',
      ].join('\n'),
      isError: t.status === 'failed' && !t.result,
    };
  }

  /** The chain ending at `t`, oldest first. */
  private chain(t: Task): Task[] {
    const out: Task[] = [t];
    let cur = t;
    while (cur.after) {
      const prev = this.tasks.get(cur.after);
      if (!prev) break;
      out.unshift(prev);
      cur = prev;
    }
    return out;
  }

  /**
   * Applies a finished task's changes to the user's working tree (not the
   * index), after a dry run. For a chained task, everything in its chain that
   * isn't applied yet comes along — its own diff alone builds on changes the
   * tree doesn't have.
   */
  async apply(id: string): Promise<{ text: string; isError?: boolean }> {
    const t = this.tasks.get(id);
    if (!t) return { text: this.unknownId(id), isError: true };
    if (t.status === 'running' || t.status === 'queued') return { text: `Task ${id} is ${t.status}; wait for it to end first.`, isError: true };
    if (!t.result) return { text: `Task ${id} ${t.status} before it changed anything.`, isError: true };
    if (t.applied) return { text: `Task ${id} was already applied.`, isError: true };
    const chain = this.chain(t);
    const lastApplied = chain.map((x) => Boolean(x.applied)).lastIndexOf(true);
    const pending = chain.slice(lastApplied + 1);
    // A run stopped at a limit counts: its changes were collected (result) and the lead reviewed them.
    const notDone = pending.find((x) => !x.result);
    if (notDone) return { text: `Task ${notDone.id} in this chain is ${notDone.status} with no changes collected; it can't be applied.`, isError: true };
    const from = lastApplied >= 0 ? chain[lastApplied].result! : chain[0].base;
    const patch = await git(t.repo, ['diff', '--binary', from, t.result!]);
    if (!patch.trim()) {
      pending.forEach((x) => {
        x.applied = true;
        this.save(x);
      });
      return { text: `Nothing to apply: ${pending.map((x) => x.id).join(', ')} changed no files.` };
    }
    const file = path.join(t.dir, pending.length > 1 ? 'chain.patch' : 'apply.patch');
    fs.writeFileSync(file, patch, { mode: 0o600 });
    try {
      await git(t.repo, ['apply', '--check', '--whitespace=nowarn', file]);
    } catch (err) {
      return {
        text: `The changes no longer apply cleanly (the files changed since the task started): ${(err as Error).message}\nThe patch is at ${file}.`,
        isError: true,
      };
    }
    await git(t.repo, ['apply', '--whitespace=nowarn', file]);
    pending.forEach((x) => {
      x.applied = true;
      this.save(x);
    });
    const files = (await git(t.repo, ['diff', '--name-only', from, t.result!])).trim().split('\n').filter(Boolean);
    log(`agent task ${id}: applied to ${t.repo} (${pending.map((x) => x.id).join(' → ')}, ${files.length} files)`);
    return {
      text: `Applied ${pending.length > 1 ? `the chain ${pending.map((x) => x.id).join(' → ')}` : `task ${id}`} to the working tree (not staged): ${files.join(', ')}.`,
    };
  }

  /** For the status bar's menu. */
  async showInteractive(): Promise<void> {
    const all = [...this.tasks.values()].sort((a, b) => b.started - a.started);
    if (all.length === 0) {
      vscode.window.showInformationMessage('No agent tasks in this window.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((t) => ({
        label: `${t.status === 'running' ? '$(sync~spin)' : t.status === 'queued' ? '$(clock)' : t.status === 'done' ? '$(check)' : '$(error)'} ${t.id} · ${t.worker}`,
        description: `${t.status}${t.applied ? ', applied' : ''} · ${t.turns} ${t.runner === 'codex' || t.runner === 'google' ? 'steps' : 'turns'} · ${t.files?.length ?? 0} files`,
        detail: t.task.slice(0, 140),
        t,
      })),
      { title: 'Agent tasks in this window' }
    );
    if (!pick) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(book) Open transcript', a: 'transcript' },
        { label: '$(output) Open raw log', a: 'log' },
        ...(pick.t.patchFile ? [{ label: '$(diff) Open patch', a: 'patch' }] : []),
        ...(pick.t.status === 'running' || pick.t.status === 'queued' ? [{ label: '$(stop) Cancel', a: 'cancel' }] : []),
      ],
      { title: pick.t.id }
    );
    if (action?.a === 'cancel') vscode.window.showInformationMessage(this.cancel(pick.t.id));
    else if (action?.a === 'transcript') await vscode.commands.executeCommand('cppo.showAgentTaskTranscript', pick.t.id);
    else if (action) {
      const file = action.a === 'log' ? path.join(pick.t.dir, 'log.jsonl') : pick.t.patchFile!;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: true });
    }
  }

  dispose(): void {
    // The window is going away — its running tasks are NOT stopped. Each run is
    // detached with a hard wall of its own and its state is on disk: the next
    // host of this window re-adopts it (or collects its finished result), and
    // the lead can still wait_task/apply_task_changes it by id. Killing here is
    // exactly what used to throw an hour of work away on every reload.
    for (const t of this.tasks.values()) {
      this.stopWatchers(t);
      if (t.status === 'running' || t.status === 'queued') {
        t.supervisor = undefined; // no one is managing it until a host takes over
        t.child = undefined;
        this.save(t);
      }
    }
    this.onDidChange.dispose();
  }
}
