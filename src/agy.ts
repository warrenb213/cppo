import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import type { UsageEntry, UsageWindow } from './usage';

/**
 * Google AI workers through Antigravity's own CLI (agy 1.4.x). Only agy uses
 * the plan's sign-in; this module never reads its credentials. Shared providers
 * keep the host's HOME and keyring, private providers use an isolated HOME with
 * no D-Bus session. This module also runs in plain Node, without VS Code.
 */

/** How to run agy for one provider. */
export interface AgyContext {
  bin: string;
  /** Own HOME directory; undefined uses the user's real one (shared sign-in). */
  home?: string;
  own: boolean;
}

/** Shown in a terminal for the user to run; never installed silently. */
export const AGY_INSTALL_COMMAND = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

// ---- Binary, homes and environment ------------------------------------------------

let binary: string | undefined;
let loginPath: Promise<string | undefined> | undefined;
const isolatedVars = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

/** Find agy on the login shell's PATH, then at the installer's default location. Only a find is cached: installing it must be noticed. */
export async function agyBinary(): Promise<string | undefined> {
  if (binary) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return binary;
    } catch {
      binary = undefined;
    }
  }
  const found = (await shellOutput('command -v agy'))?.trim().split('\n').pop();
  if (found) return (binary = found);
  const local = path.join(os.homedir(), '.local', 'bin', 'agy');
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return (binary = local);
  } catch {
    return undefined;
  }
}

/**
 * What the installer (AGY_INSTALL_COMMAND) needs that this host lacks — it can't
 * run without them: 64-bit Linux, bash, curl or wget, tar, sha512sum. Empty when it can.
 */
export async function agyInstallBlockers(): Promise<string[]> {
  if (process.platform !== 'linux') return ["Antigravity's installer is only used here on Linux"];
  const out: string[] = [];
  if (process.arch !== 'x64' && process.arch !== 'arm64') out.push(`a 64-bit x86 or ARM CPU (this is ${process.arch})`);
  const has = async (tool: string) => Boolean(await shellOutput(`command -v ${tool}`));
  if (!(await has('bash'))) out.push('bash');
  if (!(await has('curl')) && !(await has('wget'))) out.push('curl or wget');
  if (!(await has('tar'))) out.push('tar');
  if (!(await has('sha512sum'))) out.push('sha512sum (coreutils)');
  return out;
}

function shellOutput(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/bash', ['-lc', command], { timeout: 15_000 }, (err, stdout) => resolve(err ? undefined : stdout.toString().trim() || undefined));
  });
}

/** Create a private HOME for one provider's own sign-in. */
export function agyHome(root: string, providerId: string): string {
  const dir = path.join(root, 'agy', providerId, 'home');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Rediscover unreferenced sign-ins, newest first, using token metadata only (never its contents). */
export function findOrphanAgyHomes(root: string, referenced: ReadonlySet<string>): Array<{ id: string; dir: string }> {
  const base = path.join(root, 'agy');
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
    const dir = path.join(base, entry.name, 'home');
    try {
      const token = fs.lstatSync(path.join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
      if (token.isFile()) homes.push({ id: entry.name, dir, mtime: token.mtimeMs });
    } catch {
      /* no sign-in file, or the home disappeared */
    }
  }
  return homes.sort((a, b) => b.mtime - a.mtime).map(({ id, dir }) => ({ id, dir }));
}

/** Use only this plan's sign-in; preserve the real user's tools and Git configuration in a private HOME. */
export async function agyRunEnv(ctx: AgyContext, extra?: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ANTHROPIC_') || ['CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'AGY_ACCOUNT'].includes(k)) delete env[k];
  }
  Object.assign(env, { NO_COLOR: '1', TERM: 'dumb', PYTHONDONTWRITEBYTECODE: '1' });
  if (ctx.own) {
    if (!ctx.home) throw new Error('An own Google AI provider needs its own HOME');
    env.HOME = ctx.home;
    for (const k of isolatedVars) delete env[k];
    env.PATH = await (loginPath ??= shellOutput('printf %s "$PATH"')) ?? process.env.PATH;
    const gitConfig = path.join(os.homedir(), '.gitconfig');
    if (!env.GIT_CONFIG_GLOBAL && fs.existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
  }
  return env;
}

/** Quote one argument for a POSIX shell, including embedded single quotes. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Terminal command for agy's interactive sign-in, with the same HOME/keyring isolation as its runs. */
export function agySignInCommand(ctx: AgyContext): string {
  if (!ctx.own) return shQuote(ctx.bin);
  if (!ctx.home) throw new Error('An own Google AI provider needs its own HOME');
  return `env ${isolatedVars.map((k) => `-u ${k}`).join(' ')} HOME=${shQuote(ctx.home)} ${shQuote(ctx.bin)}`;
}

// ---- Process lifetime -------------------------------------------------------------

type RunResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };

/** Every headless run has a deadline and owns a process group, including shell tool descendants. */
async function run(ctx: AgyContext, args: string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  const env = await agyRunEnv(ctx);
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Keep this scheduled even if the parent exits first: a tool may ignore TERM.
      setTimeout(() => killGroup('SIGKILL'), 5_000);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-16_000)));
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
  });
}

function signInPrompt(text: string): boolean {
  return /please sign in|sign[ -]?in (?:to|with)|https?:\/\/accounts\.google\.com\/o\/oauth|(?:open|visit).*https?:.*(?:oauth|auth)|waiting for (?:authentication|authorization)|authenticate.*browser/i.test(text);
}

// ---- Model catalog ----------------------------------------------------------------

/** One model family and its actual effort slugs from `agy models`; no invented fallback catalog. */
export interface AgyModel {
  /** Family, for example gemini-4-argon. */
  id: string;
  name: string;
  note: string;
  /** Available subset, ordered low, medium, high. */
  efforts: string[];
  /** Effort to agy slug. */
  slugs: Record<string, string>;
  vendor: 'gemini' | 'claude' | 'gpt' | 'other';
  usageScope: 'gemini' | 'third-party';
}

const efforts = ['low', 'medium', 'high'];

/** Parse tab-separated slug/display-name lines and group their effort variants. */
export function parseAgyModels(stdout: string): AgyModel[] {
  const models = new Map<string, AgyModel>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([\w.-]+)-(low|medium|high)\t(.+?)\s+\((?:Low|Medium|High)\)\s*$/i.exec(line.trim());
    if (!match) continue;
    const [, id, rawEffort, name] = match;
    const effort = rawEffort.toLowerCase();
    let model = models.get(id);
    if (!model) {
      const vendor = id.startsWith('gemini') ? 'gemini' : id.startsWith('claude') ? 'claude' : id.startsWith('gpt') ? 'gpt' : 'other';
      const note = vendor === 'gemini'
        ? /argon/.test(id) ? "Google's frontier Gemini model" : /flash/.test(id) ? 'Fast and cheap Gemini model' : 'Gemini through the Google AI plan'
        : vendor === 'claude' ? `Anthropic's Claude ${/opus/.test(id) ? 'Opus' : /sonnet/.test(id) ? 'Sonnet' : 'model'} through the Google AI plan`
        : vendor === 'gpt' ? 'GPT through the Google AI plan' : 'Available through the Google AI plan';
      model = { id, name, note, efforts: [], slugs: {}, vendor, usageScope: vendor === 'gemini' ? 'gemini' : 'third-party' };
      models.set(id, model);
    }
    model.slugs[effort] = `${id}-${effort}`;
    model.efforts = efforts.filter((e) => model!.slugs[e]);
  }
  return [...models.values()];
}

/** Choose the nearest supported effort, defaulting to medium; xhigh/max clamp to high. */
export function agySlug(model: AgyModel, effort = 'medium'): string {
  const requested = efforts.indexOf(effort === 'xhigh' || effort === 'max' ? 'high' : effort);
  const target = requested < 0 ? 1 : requested;
  const supported = efforts.filter((e) => model.slugs[e]);
  supported.sort((a, b) => Math.abs(efforts.indexOf(a) - target) - Math.abs(efforts.indexOf(b) - target));
  if (!supported.length) throw new Error(`Google AI model ${model.id} has no available efforts`);
  return model.slugs[supported[0]];
}

/** Free catalog/sign-in probe. Signed-out agy can exit zero, so model lines are required. */
export async function agyModels(ctx: AgyContext): Promise<{ signedIn: boolean; models: AgyModel[]; message?: string }> {
  try {
    const r = await run(ctx, ['models'], 30_000);
    const hint = `${r.stderr}\n${r.stdout}`.trim();
    const models = parseAgyModels(r.stdout);
    if (!r.timedOut && r.code === 0 && models.length && !signInPrompt(hint)) return { signedIn: true, models };
    return { signedIn: false, models: [], message: r.timedOut ? 'agy models timed out' : hint || `agy exited with ${r.code}` };
  } catch (err) {
    return { signedIn: false, models: [], message: (err as Error).message };
  }
}

/** Confirm sign-in without starting a prompt (signed-out prompts enter interactive OAuth and hang). */
export async function agySignedIn(ctx: AgyContext): Promise<boolean> {
  return (await agyModels(ctx)).signedIn;
}

// ---- Results, streams and usage ----------------------------------------------------

/** Token counts reported by agy; thinking tokens are separate from output tokens. */
export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** A permission automatically refused by headless agy, even on a SUCCESS result. */
export interface AgyDenied {
  action: string;
  display_name?: string;
}

/** Final JSON response (also nested in the stream's result event). */
export interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  denied_actions?: AgyDenied[];
  command?: { name?: string; data?: { groups?: Array<{ name: string; buckets: Array<{ id?: string; name?: string; description?: string; window?: string; remaining_fraction?: number; reset_time?: string }> }> } };
}

/** One stream-json event, or a plain JSON result; only fields consumers read. */
export interface AgyEvent extends AgyResult {
  event?: string;
  init?: { model?: string; cwd?: string; tools?: string[]; permission_mode?: string };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: 'ACTIVE' | 'DONE';
    step_type?: 'user_input' | 'agent_response' | 'tool';
    tool_name?: string;
    tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string };
    text_delta?: string;
    duration_seconds?: number;
    usage?: AgyUsage;
  };
  result?: AgyResult;
}

/** Parse a JSON line; ignore blank lines, diagnostics and JSON primitives. */
export function parseAgyLine(line: string): AgyEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AgyEvent : undefined;
  } catch {
    return undefined;
  }
}

/** Denials from either output format; never infer success from exit code alone. */
export function deniedOf(ev: AgyEvent | undefined): AgyDenied[] {
  const denied = ev?.result?.denied_actions ?? ev?.denied_actions;
  return Array.isArray(denied) ? denied.filter((d) => d && typeof d.action === 'string') : [];
}

/** Human description for a denial, for example RunCommand (command). */
export function describeDenied(d: AgyDenied): string {
  return d.display_name ? `${d.display_name} (${d.action})` : d.action;
}

function usageWindows(result: AgyResult): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (group: string, weekly: boolean, remaining: number, reset?: string, detail?: string) => {
    if (!Number.isFinite(remaining)) return;
    const resetsAt = reset ? Date.parse(reset) : NaN;
    windows.push({ label: `${group}: ${weekly ? 'per week' : 'per 5 hours'}`, usedPct: Math.max(0, (1 - remaining) * 100), resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined, detail, scope: /gemini/i.test(group) ? 'gemini' : 'third-party' });
  };
  for (const group of result.command?.data?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (typeof bucket.remaining_fraction === 'number' && (bucket.window === 'weekly' || bucket.window === '5h')) add(group.name, bucket.window === 'weekly', bucket.remaining_fraction, bucket.reset_time, bucket.description);
    }
  }
  if (!windows.length) {
    for (const line of (result.response ?? '').split(/\r?\n/)) {
      const [group, bucket, pct, reset] = line.split('\t');
      if (!group || !bucket || !/^\d+(?:\.\d+)?%$/.test(pct ?? '') || !/week|five hour|5.?h/i.test(bucket)) continue;
      add(group, /week/i.test(bucket), parseFloat(pct) / 100, reset);
    }
  }
  return windows;
}

/** Read only the built-in /usage report (free); no model request or credential reads. */
export async function agyUsage(ctx: AgyContext): Promise<UsageEntry | undefined> {
  try {
    if (!await agySignedIn(ctx)) return undefined;
    const r = await run(ctx, ['-p=/usage', '--output-format', 'json', '--print-timeout', '30s'], 30_000);
    if (r.timedOut || r.code !== 0 || signInPrompt(r.stderr)) return undefined;
    const parsed = parseAgyLine(r.stdout);
    if (parsed?.status && parsed.status !== 'SUCCESS') return undefined;
    const windows = usageWindows(parsed ?? { response: r.stdout });
    return windows.length ? { plan: undefined, windows, source: "Antigravity's own usage report", at: Date.now() } : undefined;
  } catch {
    return undefined;
  }
}

// ---- Prompts, permissions and consultations ----------------------------------------

/** Prompt argv and any temporary material the caller must remove after the run. */
export interface AgyRunFiles {
  args: string[];
  cleanup(): void;
}

/** Keep -p attached to its value; spill large prompts outside the workspace to avoid E2BIG. */
export function agyPromptArgs(prompt: string): AgyRunFiles {
  if (Buffer.byteLength(prompt, 'utf8') <= 100_000) return { args: [`-p=${prompt}`], cleanup() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-agy-prompt-'));
  try {
    const file = path.join(dir, 'prompt.md');
    fs.writeFileSync(file, prompt, { mode: 0o600 });
    return { args: [`-p=Read ${file} first and do exactly what it says. It contains the complete instructions and task for this run.`, '--add-dir', dir], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Per-run permission settings, never persisted. No run may use the shell: agy
 * lets a model retry a refused command outside its sandbox (`BypassSandbox`)
 * and an allowed command then runs unsandboxed without a prompt, with no
 * setting to turn that off — so `command(*)` is denied for consultations AND
 * agent tasks, which edit files in their worktree and nothing else. Headless
 * ask rules are automatic denials; an MCP server needs an explicit allow.
 */
export function agyPermissions(opts?: { mcpServer?: string }): string {
  return JSON.stringify({ permissions: {
    allow: opts?.mcpServer ? [`mcp(${opts.mcpServer}/*)`] : [],
    deny: ['command(*)', 'read_url(*)', 'execute_url(*)'],
  } });
}

/**
 * One consultation in an empty temporary directory, with shell and URL tools
 * denied. Callers must confirm agySignedIn first; this also checks defensively
 * because a signed-out prompt would start interactive OAuth. No prompt stdin.
 */
export async function callAgyWorker(
  ctx: AgyContext,
  model: string,
  system: string,
  task: string,
  context: string | undefined,
  timeoutMs: number,
  effort?: string,
  models?: AgyModel[]
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; ms: number }> {
  if (!await agySignedIn(ctx)) throw new Error("Google AI isn't signed in");
  const family = models?.find((m) => m.id === model);
  if (models && !family) throw new Error(`Google AI model ${model} isn't available`);
  const slug = family ? agySlug(family, effort) : model;
  const prompt = `${system}\n\n<task>\n${task}\n</task>${context ? `\n\n<context>\n${context}\n</context>` : ''}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-agy-'));
  let files: AgyRunFiles | undefined;
  const started = Date.now();
  try {
    files = agyPromptArgs(prompt);
    const r = await run(ctx, [...files.args, '--model', slug, '--output-format', 'json', '--settings', agyPermissions(), '--print-timeout', `${timeoutMs / 1000}s`], timeoutMs, dir);
    const result = parseAgyLine(r.stdout);
    // A successful answer may itself discuss signing in; only diagnostics or
    // unstructured OAuth output indicate that the CLI entered its login flow.
    if (signInPrompt(r.stderr) || (!result?.status && signInPrompt(r.stdout))) throw new Error("Google AI isn't signed in");
    if (r.timedOut) throw new Error('Google AI timed out');
    if (r.code !== 0) throw new Error(`agy exited with ${r.code}: ${r.stderr.trim()}`);
    if (result?.status !== 'SUCCESS') throw new Error(`Google AI run failed: ${result?.status ?? (r.stderr.trim() || 'invalid JSON result')}`);
    const denied = deniedOf(result);
    const text = result.response ?? '';
    if (!text.trim()) {
      if (denied.length) throw new Error(`Google AI tried an action it isn't allowed to in a consultation (${denied.map(describeDenied).join(', ')}) and returned nothing`);
      if (/jetski: no output produced.*tool required/i.test(r.stderr)) throw new Error(`Google AI tried an action it isn't allowed to in a consultation and returned nothing: ${r.stderr.trim()}`);
      throw new Error('Google AI returned an empty response');
    }
    return { text, inputTokens: result.usage?.input_tokens, outputTokens: result.usage ? (result.usage.output_tokens ?? 0) + (result.usage.thinking_tokens ?? 0) : undefined, ms: Date.now() - started };
  } finally {
    files?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Check image generation once, on the cheapest available family, without touching the workspace. */
export async function agyImageSupport(ctx: AgyContext, models: AgyModel[]): Promise<boolean | undefined> {
  if (!models.length || !await agySignedIn(ctx)) return undefined;
  const model = models.find((m) => /flash/i.test(m.id)) ?? models.find((m) => m.vendor === 'gemini') ?? models[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-agy-facts-'));
  try {
    const r = await run(ctx, ['-p=Reply with the single word OK', '--model', agySlug(model, 'low'), '--output-format', 'stream-json', '--print-timeout', '60s', '--settings', agyPermissions()], 60_000, dir);
    if (r.timedOut || r.code !== 0) return undefined;
    for (const line of r.stdout.split(/\r?\n/)) {
      const ev = parseAgyLine(line);
      if (ev?.event === 'init' && Array.isArray(ev.init?.tools)) return ev.init.tools.includes('generate_image');
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Agent runner files and arguments ----------------------------------------------

/** Streamed agent arguments. The attached -p value comes first. */
export function agyAgentArgs(opts: { slug: string; settings: string; promptArgs: string[]; timeoutSec: number }): string[] {
  return [...opts.promptArgs, '--model', opts.slug, '--output-format', 'stream-json', '--settings', opts.settings, '--print-timeout', `${opts.timeoutSec}s`];
}

/** Write a run's cppo MCP server config, exclusively; never overwrite an existing workspace config. */
export function writeAgyMcpConfig(worktree: string, url: string, token: string): { path: string; created: boolean } {
  const dir = path.join(worktree, '.agents');
  const file = path.join(dir, 'mcp_config.json');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { cppo: { serverUrl: url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600, flag: 'wx' });
    return { path: file, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { path: file, created: false };
    throw err;
  }
}

/** Remove only a config this runner created (call only when created was true), and its directory if empty. */
export function removeAgyMcpConfig(worktree: string): void {
  const dir = path.join(worktree, '.agents');
  fs.rmSync(path.join(dir, 'mcp_config.json'), { force: true });
  try { fs.rmdirSync(dir); } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}

/** Images generated in agy's brain directory, modified since the run started, newest first. */
export function collectAgyImages(home: string | undefined, conversationId: string, since: number): string[] {
  // Conversation IDs are path components, never paths supplied by model output.
  if (!conversationId || conversationId === '.' || conversationId === '..' || /[/\\]/.test(conversationId)) return [];
  const dir = path.resolve(home ?? os.homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId);
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.(?:jpe?g|png|webp)$/i.test(e.name)).flatMap((e) => {
      try {
        const file = path.join(dir, e.name);
        const stat = fs.lstatSync(file);
        return stat.isFile() && stat.mtimeMs >= since ? [{ file, mtime: stat.mtimeMs }] : [];
      } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime).map((e) => e.file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
