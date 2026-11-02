import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AGY_INSTALL_COMMAND, AgyContext, AgyModel, agyBinary, agyHome, agyImageSupport, agyInstallBlockers, agyModels, agySignedIn, agySignInCommand, findOrphanAgyHomes } from './agy';
import { WindowBinding } from './binding';
import { LOGIN_PROVIDER } from './delegate';
import type { Worker, WorkerSource } from './delegate';
import type { AgentRunSpec } from './agentTasks';
import type { RolePolicy } from './roles';
import { HostState } from './hostState';
import { readIdentity } from './accounts';
import { allWorkingDirs, workingRoot } from './workdir';
import { NOTICE_KEY } from './setupWizard';
import { log } from './log';
import { CatalogModel, Family, FAMILIES, fetchCatalog, modelSettings, newest, OtherModel, toAnthropic } from './modelCatalog';
import { ensureProxy, install, isInstalled, ProxyHandle, proxyConfig, proxyLogFile, proxyPort, stopProxy } from './litellm';
import {
  CODEX_FALLBACK_MODELS,
  CodexAuth,
  codexBinary,
  CodexContext,
  CodexModel,
  codexAccount,
  codexCapabilities,
  codexModels,
  findOrphanCodexHomes,
  keyCodexHome,
  testCodex,
  userCodexHome,
} from './codex';

/**
 * Billing providers: WHERE a window's requests go and WHO pays for them, kept
 * apart from the ACCOUNT (identity, history, settings, project trust).
 *
 * "Anthropic" — the default — is the window's own Anthropic login: a claude.ai
 * plan (Pro, Max, Team, Enterprise) or a Console key from /login. A provider is
 * either an Anthropic API key (native, no base URL or model rewriting) or an
 * Anthropic-compatible gateway — Poe, a company proxy — reached with a base URL
 * and a key. Claude Code ranks ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY above a
 * saved /login, and the login "stays saved and unused while the variable is set"
 * (code.claude.com/docs/en/llm-gateway-connect). So a window flips to a gateway
 * and back without ever touching its login: running out of subscription usage
 * means picking another provider, not signing in as someone else.
 *
 * How it reaches Claude Code
 * ──────────────────────────
 * Through the `env` block of the window's OWN settings.json — the one in its
 * working dir, which is its CLAUDE_CONFIG_DIR and belongs to no other window.
 * Not process.env, the channel used for CLAUDE_CONFIG_DIR: keys live in
 * SecretStorage, which is async, and Claude Code may spawn `claude` before an
 * await returns — the provider would silently not apply. settings.json is read
 * by every `claude` process when it starts, so there is no race; and the
 * window's integrated terminals point at the same dir, so a `claude` run there
 * follows the window's provider with no extra plumbing.
 *
 * Where things are kept
 * ─────────────────────
 * A provider belongs to one ACCOUNT on one HOST: definitions in this host's
 * state file (hostState.ts), under the account's email, so a window sees only
 * the providers of the account it runs, here. Keys are in SecretStorage, which
 * lives on the CLIENT and is shared by every host — so each key's name carries
 * this host's id. (Up to 1.7 both were client-wide, shared by every host and
 * account; migrate() splits them up.) The per-window choice is in
 * workspaceState, and the settings.json carries a copy of the key next to the
 * OAuth token the same dir already holds (0600).
 *
 * Models
 * ──────
 * A gateway serves its own set of models under its own names. The provider keeps
 * the gateway's list (from its `/v1/models`, see modelCatalog.ts) and the window
 * gets the settings that make Claude Code's model picker and effort slider work
 * on exactly that set.
 */

export interface Provider {
  id: string;
  name: string;
  /**
   * 'anthropic': an Anthropic API key, sent straight to Anthropic. 'codex': OpenAI
   * Codex — GPT through the Codex CLI for workers and agent tasks (codex.ts); on
   * an API key, also chat windows through the local proxy. 'google': Google AI
   * through Antigravity's CLI, plan workers and edit-only agent tasks. Unset: a gateway.
   */
  kind?: 'anthropic' | 'codex' | 'google';
  /** Google AI plan only: a private HOME (default), or this Linux user's shared sign-in. */
  googleHome?: 'own' | 'shared';
  /** Google AI's model families and image capability, reported by agy itself. */
  googleModels?: AgyModel[];
  googleImages?: boolean;
  /** Codex only: its ChatGPT plan (Codex's own sign-in) or an OpenAI API key. */
  codexAuth?: CodexAuth;
  /**
   * Codex ChatGPT plan only: whose sign-in it uses. 'own': a Codex home of its own
   * (~/.claude-windows/codex/<id>), signed in for this provider alone. 'shared':
   * this host's Codex sign-in (~/.codex) — one per Linux user, whatever Claude
   * account asks. Unset (providers from before 1.17.1): shared.
   */
  codexHome?: 'own' | 'shared';
  /** Codex only: the models it offers, from its `model/list`. */
  codexModels?: CodexModel[];
  /** Codex only: the account can generate images (`modelProvider/capabilities/read`). */
  codexImages?: boolean;
  /** A gateway added from a preset (see PRESETS); unset for a custom one. */
  preset?: GatewayPreset;
  baseUrl: string;
  /** How the gateway takes its key: `Authorization: Bearer` or `x-api-key`. */
  auth: 'bearer' | 'x-api-key';
  /** Per-family picks (gateway IDs). A family without one gets the catalog's newest. */
  models?: Partial<Record<Family, string>>;
  /** The Claude models the gateway serves to Claude Code, from its `/v1/models`. */
  catalog?: CatalogModel[];
  /** When the catalog was read (ms). */
  catalogAt?: number;
  /** Non-Claude models the gateway serves in OpenAI's format, from the same list. */
  otherCatalog?: OtherModel[];
  /** The non-Claude models the user enabled. Any at all routes the provider through the local LiteLLM proxy. */
  extraModels?: string[];
  /** For gateways that reject Anthropic's experimental `anthropic-beta` headers. */
  disableBetas?: boolean;
  /** The shared (≤ 1.7) provider this one was adopted from, when its id changed — windows may still name it. */
  legacyId?: string;
  /** Models of this provider the window's AI may consult as workers (see delegate.ts). Off when unset. */
  workers?: string[];
  /** Of those, the ones that may also run agent tasks (agentTasks.ts): tools, in a worktree. */
  agentWorkers?: string[];
}

/** Where versions up to 1.7 kept every provider: globalState, shared by every host and account. */
const LEGACY_PROVIDERS_KEY = 'claudeProfiles.providers';
const ACTIVE_KEY = 'claudeProfiles.activeProvider';
const HIDE_OVERRIDE_WARNING_KEY = 'claudeProfiles.hideProviderOverrideWarning';
/** workspaceState: the window's own values of MANAGED_TOP, saved when a provider took them over. */
const STASH_KEY = 'claudeProfiles.providerStash';
/** How old a catalog may get before a window using the provider re-reads it. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const legacySecretKey = (id: string) => `claudeProfiles.provider.${id}`;
const ANTHROPIC_API = 'https://api.anthropic.com';
const isNative = (p: Provider) => p.kind === 'anthropic';
const isGoogle = (p: Provider) => p.kind === 'google';
const sharesUserGoogle = (p: Provider) => isGoogle(p) && p.googleHome === 'shared';
const isCodex = (p: Provider) => p.kind === 'codex';
/** A Codex ChatGPT-plan provider on this host's own Codex sign-in (~/.codex) — shared with every Claude account here. */
const sharesUserCodex = (p: Provider) => isCodex(p) && p.codexAuth !== 'api-key' && p.codexHome !== 'own';

/** Plan providers use their own clients for workers only; a Codex API key can also serve chat windows. */
const chatCapable = (p: Provider) => !isGoogle(p) && (!isCodex(p) || p.codexAuth === 'api-key');

const OPENAI_API = 'https://api.openai.com';

/** Where the local proxy sends a provider's translated models. */
function proxyBase(p: Provider): string {
  return isCodex(p) ? OPENAI_API : p.baseUrl;
}

/**
 * Claude Code's model slots on an OpenAI window. Every request names one of
 * them (the haiku slot also runs titles and summaries), so each gets a GPT
 * model the window enabled: the user's pick, else the closest match.
 */
function codexSlots(p: Provider): Partial<Record<Family, string>> {
  const on = p.extraModels ?? [];
  if (on.length === 0) return {};
  const pick = (chosen: string | undefined, pref: string[]) =>
    (chosen && on.includes(chosen) ? chosen : undefined) ?? pref.find((m) => on.includes(m)) ?? on[0];
  return {
    opus: pick(p.models?.opus, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol']),
    sonnet: pick(p.models?.sonnet, ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']),
    haiku: pick(p.models?.haiku, ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-sol']),
  };
}

/** What the provider is, in a menu's description column. */
function describeKind(p: Provider): string {
  if (isNative(p)) return 'Anthropic API key';
  if (isGoogle(p)) return `Google AI (Antigravity) · Google AI plan · ${sharesUserGoogle(p) ? "host's shared sign-in" : 'own sign-in'} · workers`;
  if (isCodex(p)) {
    return p.codexAuth === 'api-key'
      ? `OpenAI Codex · API key · workers${p.extraModels?.length ? ' + chat windows' : ''}`
      : `OpenAI Codex · ChatGPT plan · ${sharesUserCodex(p) ? "host's shared sign-in" : 'own sign-in'} · workers`;
  }
  return p.preset ? PRESETS[p.preset].label : p.baseUrl;
}

/**
 * Gateways known well enough to set up from a name and a key. Anything else is
 * added as a custom gateway (base URL + key header asked for).
 */
interface PresetDef {
  label: string;
  /** Default provider name (status bar). */
  name: string;
  detail: string;
  baseUrl: string;
  auth: 'bearer' | 'x-api-key';
  keyHint: string;
  /** Models come from the gateway's /v1/models (true) or are fixed by `models`. */
  readsCatalog: boolean;
  models?: Partial<Record<Family, string>>;
  /** Extra env the gateway's documented Claude Code setup asks for (must be in MANAGED_ENV). */
  env?: Record<string, string>;
}

type GatewayPreset = 'poe' | 'zai';

const PRESETS: Record<GatewayPreset, PresetDef> = {
  poe: {
    label: 'Poe',
    name: 'Poe',
    detail: 'Claude models on a Poe subscription; other models (GLM, Qwen…) optionally, through a local proxy',
    baseUrl: 'https://api.poe.com',
    auth: 'bearer',
    keyHint: 'From poe.com/api_key',
    readsCatalog: true,
  },
  zai: {
    label: 'Z.ai GLM Coding Plan',
    name: 'Z.ai',
    detail: "GLM models on Z.ai's Anthropic-compatible endpoint — no proxy needed",
    baseUrl: 'https://api.z.ai/api/anthropic',
    auth: 'bearer',
    keyHint: 'An API key from your Z.ai Coding Plan (z.ai → API keys)',
    // Z.ai's documented Claude Code setup (docs.z.ai/devpack/tool/claude): GLM
    // in every slot, `[1m]` so Claude Code knows the 1M window, compaction and
    // a long timeout to match. Its slots are fixed, so no model list is read —
    // that list would only offer GLM again, through the proxy it doesn't need.
    models: { opus: 'glm-5.3[1m]', sonnet: 'glm-5.3[1m]', haiku: 'glm-5.3-flash[1m]' },
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', API_TIMEOUT_MS: '3000000' },
    readsCatalog: false,
  },
};

/** Whether a provider's models come from its /v1/models list (custom gateways and Poe) or are fixed. */
function readsCatalog(p: Provider): boolean {
  if (isNative(p) || isCodex(p) || isGoogle(p)) return false;
  return p.preset ? PRESETS[p.preset].readsCatalog : true;
}

/** A model Anthropic serves: an alias (opus, sonnet[1m], default…) or a Claude ID. */
function isClaudeModel(model: string): boolean {
  const m = model.trim().replace(/\[1m\]$/i, '');
  return /^(default|best|opusplan|opus|sonnet|haiku|fable)$/i.test(m) || /^claude-/i.test(m) || Boolean(toAnthropic(m));
}

/**
 * What a window's own Anthropic login is, read from its files: "Team plan ·
 * Acme", "Max plan", "Console API key". Not from `claude auth status`, which
 * reports the provider's key instead while one is active.
 */
export function describeLogin(dir: string | undefined): string {
  if (!dir) return 'Anthropic login';
  const read = (f: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const config = read('.claude.json');
  const plan = (read('.credentials.json').claudeAiOauth as { subscriptionType?: unknown } | undefined)
    ?.subscriptionType;
  if (typeof plan === 'string' && plan) {
    const org = (config.oauthAccount as { organizationName?: unknown } | undefined)?.organizationName;
    const name = `${plan[0].toUpperCase()}${plan.slice(1)} plan`;
    return plan !== 'pro' && plan !== 'max' && typeof org === 'string' && org ? `${name} · ${org}` : name;
  }
  if (config.primaryApiKey) return 'Console API key (/login), billed per token';
  return 'Anthropic login';
}

/**
 * Claude Code asks before using an ANTHROPIC_API_KEY it hasn't seen ("Detected a
 * custom API key"), defaulting to No — and a No silently falls back to the
 * login. The user already chose this key here, so it is approved the way Claude
 * Code records it: the key's last 20 characters, in the dir's .claude.json.
 */
function approveApiKey(dir: string, key: string): void {
  const file = path.join(dir, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return; // never clobber a file we can't read
  }
  const tail = key.trim().slice(-20);
  const prev = (config.customApiKeyResponses ?? {}) as { approved?: string[]; rejected?: string[] };
  const approved = Array.isArray(prev.approved) ? prev.approved : [];
  const rejected = Array.isArray(prev.rejected) ? prev.rejected : [];
  if (approved.includes(tail) && !rejected.includes(tail)) return;
  config.customApiKeyResponses = {
    ...prev,
    approved: approved.includes(tail) ? approved : [...approved, tail],
    rejected: rejected.filter((r) => r !== tail),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Every env var a provider may set. All of them are removed when the window goes
 * back to its Anthropic login — including the ones the current provider leaves
 * unset, so nothing from a previous provider can linger.
 */
const MANAGED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_AUTO_MODE_SERVER',
  // Set by presets (Z.ai).
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'API_TIMEOUT_MS',
] as const;

/**
 * Top-level settings a provider takes over. Unlike the env vars these are things
 * a user might set for themselves, so the window's own values are saved when a
 * provider takes them over and put back when it goes — a leftover override would
 * send a gateway's model name to Anthropic.
 */
const MANAGED_TOP = ['modelOverrides', 'availableModels', 'enforceAvailableModels', 'modelPicker'] as const;

interface ProviderSettings {
  env: Record<string, string>;
  top: Partial<Record<(typeof MANAGED_TOP)[number], unknown>>;
  /** Leave the window's own MANAGED_TOP values in place (native Anthropic serves the usual models). */
  keepTop?: boolean;
}

/**
 * Everything a provider writes. The unused credential is set EMPTY, not left out:
 * settings env overrides shell exports, so an ANTHROPIC_* key in the user's shell
 * can't sneak past it.
 */
export function settingsFor(p: Provider, key: string, proxy?: ProxyHandle): ProviderSettings {
  if (isGoogle(p)) throw new Error(`${p.name} runs on your Google AI plan, which only Antigravity itself may use — it can't serve a chat window.`);
  // Anthropic itself: just the key. The base URL is pinned so a shell export
  // can't redirect it; Claude Code's own model lineup applies unchanged.
  if (isNative(p)) {
    return { env: { ANTHROPIC_BASE_URL: ANTHROPIC_API, ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '' }, top: {}, keepTop: true };
  }
  if (isCodex(p)) {
    // OpenAI, API key: every model is translated by the local proxy — none is
    // Claude, and OpenAI isn't Anthropic-compatible, so there's no direct path.
    if (!proxy) throw new Error(`${p.name} needs the local LiteLLM proxy for chat windows, and it isn't running.`);
    const slots = codexSlots(p);
    const on = p.extraModels ?? [];
    return {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
        ANTHROPIC_AUTH_TOKEN: proxy.masterKey,
        ANTHROPIC_API_KEY: '',
        ...(slots.opus && { ANTHROPIC_DEFAULT_OPUS_MODEL: slots.opus }),
        ...(slots.sonnet && { ANTHROPIC_DEFAULT_SONNET_MODEL: slots.sonnet }),
        ...(slots.haiku && { ANTHROPIC_DEFAULT_HAIKU_MODEL: slots.haiku }),
        // Anthropic's beta headers and in-request safety checks mean nothing to OpenAI.
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        CLAUDE_CODE_AUTO_MODE_SERVER: '0',
      },
      top: {
        // Only the enabled GPT models: a Claude model saved earlier falls back to one of them.
        availableModels: on,
        enforceAvailableModels: true,
        modelPicker: { options: on.map((id) => ({ model: id, description: `${p.name} · OpenAI, translated by the local LiteLLM proxy` })) },
      },
    };
  }
  const models = modelSettings(p.catalog, p.models);
  // Through the proxy, the window holds only the proxy's own key; the gateway key
  // stays in the proxy's environment.
  const env: Record<string, string> = proxy
    ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`, ANTHROPIC_AUTH_TOKEN: proxy.masterKey, ANTHROPIC_API_KEY: '' }
    : {
        ANTHROPIC_BASE_URL: p.baseUrl,
        ANTHROPIC_AUTH_TOKEN: p.auth === 'bearer' ? key : '',
        ANTHROPIC_API_KEY: p.auth === 'x-api-key' ? key : '',
      };
  Object.assign(env, models.env);
  if (p.disableBetas) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  // Auto mode asks Anthropic's API to run its safety checks inside each request
  // (the `safeguards` field → `safeguard_results`). A gateway can't — Poe isn't
  // Anthropic, and a translated model isn't even the Messages API — so Claude
  // Code falls back to its own classifier requests (every action is still
  // checked), after holding the first one behind an "isn't eligible" notice.
  // Telling it up front gives the same fallback without the notice.
  // (code.claude.com/docs/en/auto-mode-classifier-billing)
  env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';
  if (p.preset) Object.assign(env, PRESETS[p.preset].env ?? {});
  const top: ProviderSettings['top'] = {};
  if (models.modelOverrides) top.modelOverrides = models.modelOverrides;
  if (models.availableModels) top.availableModels = models.availableModels;
  if (models.enforceAvailableModels) top.enforceAvailableModels = true;
  const extras = proxy ? p.extraModels ?? [] : [];
  if (extras.length > 0) {
    // Claude Code's gateway discovery only lists IDs containing "claude", so the
    // other models get picker rows of their own — and must be on the allowlist.
    if (models.availableModels) top.availableModels = [...models.availableModels, ...extras];
    top.modelPicker = {
      options: extras.map((id) => ({ model: id, description: `${p.name} · translated by the local LiteLLM proxy` })),
    };
  }
  return { env, top };
}

/** The gateway names of the Claude models a provider routes: its catalog, plus manual picks. */
function claudeGatewayIds(p: Provider): string[] {
  const ids = new Set((p.catalog ?? []).map((m) => m.gatewayId));
  for (const id of Object.values(p.models ?? {})) if (id && toAnthropic(id)) ids.add(id);
  return [...ids];
}

/** "opus → claude-opus-4.8, …" — what each family resolves to on this provider. */
export function describeModels(p: Provider): string {
  const { env, modelOverrides = {} } = modelSettings(p.catalog, p.models);
  return FAMILIES.filter((f) => env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`])
    .map((f) => {
      const id = env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`];
      return `${f} → ${modelOverrides[id] ?? id}`; // the gateway's name, as the user knows it
    })
    .join(', ');
}

export type TestResult =
  | { ok: true; model: string; ms: number }
  | { ok: false; model: string; status?: number; message: string; hint: string };

/** The model a connection test asks for: the cheapest one Claude Code would use here, as it sends it. */
function testModel(p: Provider): string {
  if (isNative(p)) return 'claude-haiku-4-5';
  const pick =
    p.models?.haiku ??
    (p.catalog ? newest(p.catalog, 'haiku')?.gatewayId : undefined) ??
    p.models?.sonnet ??
    (p.catalog ? newest(p.catalog, 'sonnet')?.gatewayId : undefined) ??
    p.models?.opus ??
    'claude-sonnet-4-6';
  return pick.replace(/(\[1m\])+$/i, ''); // Claude Code's own marker for the 1M window, never sent
}

/**
 * One request to the provider exactly as Claude Code would send it — same
 * endpoint, key header and model — asking for a single output token. Catches a
 * wrong key, an inactive plan or empty balance, a wrong endpoint or an unknown
 * model when the provider is added, instead of as a "hang" in the first chat:
 * Claude Code retries a 429 up to 11 times, quietly.
 */
export async function testProvider(p: Provider, key: string): Promise<TestResult> {
  const model = testModel(p);
  const url = `${(isNative(p) ? ANTHROPIC_API : p.baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (isNative(p) || p.auth === 'x-api-key') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true, model, ms: Date.now() - started };
    const text = await res.text();
    let message = text.trim();
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      const m = typeof body.error === 'object' ? body.error?.message : (body.error ?? body.message);
      if (typeof m === 'string' && m) message = m;
    } catch {
      /* not JSON: keep the text */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? 'The key was rejected — check it, and that it belongs to this provider.'
        : res.status === 404
          ? `The endpoint or the model "${model}" wasn't found — check the base URL and model aliases.`
          : res.status === 429
            ? "Rate-limited — or the account's plan or balance doesn't cover this. Claude Code would keep retrying this and look hung."
            : res.status === 400
              ? `The request was refused — often a model name ("${model}") this provider doesn't serve.`
              : 'The provider answered with an error.';
    return { ok: false, model, status: res.status, message: message.slice(0, 300), hint };
  } catch (err) {
    return { ok: false, model, message: (err as Error).message, hint: `Couldn't reach ${url}.` };
  }
}

/** Claude Code model aliases a login worker may run (Claude Code resolves them to the current models). */
const LOGIN_WORKER_NOTES: Record<string, string> = {
  haiku: 'Claude Haiku — fast: summaries, quick checks',
  sonnet: 'Claude Sonnet — reviews, second opinions, careful answers',
  opus: 'Claude Opus — the hardest questions',
};

/** The models a provider can offer as workers, with a one-line note for the lead. */
export function workerChoices(p: Provider): Array<{ model: string; note: string }> {
  if (isGoogle(p)) return (p.googleModels ?? []).map((m) => ({ model: m.id, note: `${m.name} — ${m.note.replace(/\.$/, '')} (Google AI)` }));
  if (isCodex(p)) {
    return (p.codexModels?.length ? p.codexModels : CODEX_FALLBACK_MODELS).map((m) => ({
      model: m.id,
      note: `${m.name} — ${m.note.replace(/\.$/, '')} (Codex)`,
    }));
  }
  if (isNative(p)) {
    return [
      { model: 'claude-haiku-5-5', note: 'Claude Haiku — fast: summaries, bulk rewriting, quick checks' },
      { model: 'claude-sonnet-5-5', note: 'Claude Sonnet — balanced: reviews, drafts, second opinions' },
      { model: 'claude-opus-5-5', note: 'Claude Opus — strongest: hard reasoning, careful reviews' },
    ];
  }
  if (p.preset === 'zai') {
    return [
      { model: 'glm-5.3', note: 'GLM-5.3 — second opinions, reviews, harder questions (slower)' },
      { model: 'glm-5.3-flash', note: 'GLM-5.3-Flash — fast: summaries, bulk rewriting, quick checks' },
    ];
  }
  const ids = p.catalog?.length
    ? p.catalog.map((m) => m.gatewayId)
    : Object.values(p.models ?? {}).filter((m): m is string => Boolean(m));
  return [...new Set(ids.map((m) => m.replace(/(\[1m\])+$/i, '')))].map((model) => ({ model, note: `${model} on ${p.name}` }));
}

function formatModels(m: Provider['models']): string {
  return FAMILIES
    .filter((k) => m?.[k])
    .map((k) => `${k}=${m![k]}`)
    .join(', ');
}

function parseModels(input: string): Provider['models'] | string {
  const models: NonNullable<Provider['models']> = {};
  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(opus|sonnet|haiku|fable)\s*=\s*(\S+)$/i.exec(part);
    if (!m) return `"${part}" — expected alias=model, e.g. sonnet=claude-sonnet-4-5`;
    models[m[1].toLowerCase() as Family] = m[2];
  }
  return models;
}

/** A worker's id: "<provider name, slugged>/<model>" (e.g. "z-ai/glm-5.3"). */
function workerId(p: Provider, model: string): string {
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  return `${slug}/${model}`;
}

/**
 * Which service a provider is, for the terms warning: two providers of the same
 * service on one host — two Z.ai keys, a second Codex sign-in, two Anthropic API
 * keys — are two accounts with that service.
 */
function serviceOf(p: Provider): { key: string; label: string } {
  if (isNative(p)) return { key: 'anthropic-api', label: 'Anthropic' };
  if (isCodex(p)) return { key: 'openai', label: 'OpenAI' };
  if (isGoogle(p)) return { key: 'google', label: 'Google AI' };
  if (p.preset) return { key: p.preset, label: PRESETS[p.preset].label };
  let host = p.baseUrl;
  try {
    host = new URL(p.baseUrl).host;
  } catch {
    /* keep the URL */
  }
  return { key: `custom:${host}`, label: host };
}

/**
 * A model some provider of this account can serve, whether or not it is enabled
 * as a worker yet, and what it can do — the orchestration panel's inventory.
 */
export interface ModelOffer {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  note: string;
  kind?: 'login' | 'codex' | 'google';
  noShell?: boolean;
  usageScope?: string;
  preset?: string;
  plan: boolean;
  can: { answer: boolean; agent: boolean; image: boolean; vision: boolean };
  /** Why a capability is missing, shown next to it. */
  limits: string[];
  enabled: boolean;
  agentEnabled: boolean;
}

export class ProviderManager implements vscode.Disposable, WorkerSource {
  /** Fires when this window's provider, or its definition, changes. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly binding: WindowBinding,
    private readonly state: HostState
  ) {}

  private version(): string {
    return String((this.context.extension?.packageJSON as { version?: unknown } | undefined)?.version ?? '0');
  }

  /** The account this window runs — providers belong to it, on this host. */
  private email(): string | undefined {
    const dir = this.binding.getEnvDir();
    return dir ? readIdentity(dir)?.email : undefined;
  }

  /** This account's providers on this host. */
  list(): Provider[] {
    const email = this.email();
    if (!email) return [];
    return this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {})[email] ?? [];
  }

  /** By id — or by the shared provider's id it was adopted from, which a window may still hold. */
  private get(id: string): Provider | undefined {
    const list = this.list();
    return list.find((p) => p.id === id) ?? list.find((p) => p.legacyId === id);
  }

  private async save(list: Provider[]): Promise<void> {
    const email = this.email();
    if (!email) throw new Error('This window has no signed-in account — providers belong to an account.');
    list.sort((a, b) => a.name.localeCompare(b.name));
    const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
    if (list.length > 0) all[email] = list;
    else delete all[email];
    await this.state.update('claudeProfiles.providers', all);
  }

  /**
   * Where a provider's key lives in the client's secret storage. SecretStorage is
   * on the CLIENT, shared by every host, so the name carries this host's id: the
   * same provider id on two hosts never shares — or deletes — the other's key.
   */
  private secretKey(id: string): string {
    let host = this.state.get<string>('claudeProfiles.hostId');
    if (!host) {
      host = crypto.randomBytes(6).toString('hex');
      void this.state.update('claudeProfiles.hostId', host);
    }
    return `claudeProfiles.provider.${host}.${id}`;
  }

  /**
   * One-time, per host: adopt the providers versions up to 1.7 kept in
   * globalState, which every host and every account shared.
   *
   * A provider goes to each account that has a window on THIS host using it right
   * now — its key in the window's settings.json, or its local proxy's port —
   * and to no one else. The first account keeps its id (the running proxy and
   * the windows' settings stay valid); another account on the same host gets a
   * new id, so their proxies can't collide. Each copy gets its own key entry.
   *
   * globalState and the old key entries are left alone: hosts still on an older
   * version read them, and other hosts adopt from them when they update.
   */
  async migrate(): Promise<void> {
    if (this.state.get<boolean>('claudeProfiles.providersMigrated')) return this.dropLegacy();
    const legacy = this.context.globalState.get<Provider[]>(LEGACY_PROVIDERS_KEY, []);
    // Several windows may activate at once: one adopts, the others wait for it.
    const lock = path.join(workingRoot(), '.providers-migration.lock');
    try {
      fs.mkdirSync(workingRoot(), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    } catch {
      // Another window is adopting. A lock older than a minute was left by one
      // that died: clear it so the next activation retries.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      return;
    }
    try {
      const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
      const used = new Set<string>(); // legacy ids already adopted on this host
      for (const p of legacy) {
        const key = await this.context.secrets.get(legacySecretKey(p.id));
        if (!key) continue;
        const port = proxyPort(p.id);
        const owners = new Map<string, boolean>(); // email → uses the running proxy
        for (const dir of allWorkingDirs()) {
          let env: Record<string, string> = {};
          try {
            env = (JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).env ?? {}) as Record<string, string>;
          } catch {
            continue;
          }
          const direct = env.ANTHROPIC_AUTH_TOKEN === key || env.ANTHROPIC_API_KEY === key;
          const proxied = port !== undefined && env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${port}`;
          const email = readIdentity(dir)?.email;
          if ((direct || proxied) && email) owners.set(email, (owners.get(email) ?? false) || proxied);
        }
        // The account on the running proxy keeps the id, so its windows stay as they are.
        for (const email of [...owners.keys()].sort((a, b) => Number(owners.get(b)) - Number(owners.get(a)))) {
          const copy: Provider = used.has(p.id)
            ? { ...p, id: crypto.randomBytes(6).toString('hex'), legacyId: p.id }
            : { ...p };
          used.add(p.id);
          await this.context.secrets.store(this.secretKey(copy.id), key);
          all[email] = [...(all[email] ?? []).filter((q) => q.id !== copy.id), copy];
          log(`provider ${p.name}: adopted on this host for ${email}${copy.legacyId ? ` as ${copy.id}` : ''}`);
        }
        if (owners.size === 0) log(`provider ${p.name}: not in use on this host — not adopted here`);
      }
      await this.state.update('claudeProfiles.providers', all);
      await this.state.update('claudeProfiles.providersMigrated', true);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    await this.dropLegacy();
  }

  /**
   * The ≤ 1.7 shared copy — every provider and its key, client-wide — once this
   * host has adopted what it needs. Removed so no stale key lingers in secret
   * storage (user's choice in 1.13). A host still on ≤ 1.7 then starts with no
   * providers; one on ≥ 1.8 that hasn't migrated yet adopts nothing.
   */
  private async dropLegacy(): Promise<void> {
    const legacy = this.context.globalState.get<Provider[]>(LEGACY_PROVIDERS_KEY);
    if (!legacy) return;
    for (const p of legacy) {
      try {
        await this.context.secrets.delete(legacySecretKey(p.id));
      } catch {
        /* already gone */
      }
    }
    await this.context.globalState.update(LEGACY_PROVIDERS_KEY, undefined);
    log(`providers: removed the pre-1.8 shared copy (${legacy.map((p) => p.name).join(', ') || 'empty'}) and its key entries`);
  }

  /** The provider this window bills to; undefined = its Anthropic login. */
  active(): Provider | undefined {
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY);
    const p = id ? this.get(id) : undefined;
    return p && chatCapable(p) ? p : undefined;
  }

  /**
   * This window's settings.json — only while the window runs in its own working
   * dir. An unbound window runs on the DEFAULT dir, shared with every other
   * unbound window and with plain `claude` in any shell; a provider written there
   * would leak far beyond this window.
   */
  private settingsFile(): string | undefined {
    const dir = this.binding.getEnvDir();
    if (!dir || path.normalize(dir) !== path.normalize(this.binding.workingDir())) return undefined;
    return path.join(dir, 'settings.json');
  }

  /** This window's own CLAUDE_CONFIG_DIR, when it runs in one (see settingsFile). */
  ownConfigDir(): string | undefined {
    const file = this.settingsFile();
    return file ? path.dirname(file) : undefined;
  }

  private loginDirFn: () => string | undefined = () => undefined;

  /** Wired at activation: the account store of the window's account (extension.ts). */
  setLoginDir(fn: () => string | undefined): void {
    this.loginDirFn = fn;
  }

  /** WorkerSource: the account's own directory, for workers on its Anthropic login. */
  loginDir(): string | undefined {
    return this.loginDirFn();
  }

  /** Claude models on this account's own login that are enabled as workers. */
  private loginWorkers(): string[] {
    const email = this.email();
    return email ? (this.state.get<Record<string, string[]>>('claudeProfiles.loginWorkers', {})[email] ?? []) : [];
  }

  private async setLoginWorkers(models: string[]): Promise<void> {
    const email = this.email();
    if (!email) return;
    const all = this.state.get<Record<string, string[]>>('claudeProfiles.loginWorkers', {});
    if (models.length > 0) all[email] = models;
    else delete all[email];
    await this.state.update('claudeProfiles.loginWorkers', all);
    this.onDidChange.fire();
  }

  /** WorkerSource: every model of this account's providers enabled as a worker. */
  workers(): Worker[] {
    const login = this.loginWorkers().map((model) => ({
      id: `anthropic-login/${model}`,
      providerId: '__login__',
      providerName: LOGIN_PROVIDER,
      model,
      baseUrl: ANTHROPIC_API,
      auth: 'x-api-key' as const,
      note: `${LOGIN_WORKER_NOTES[model] ?? model} — on this account's own subscription`,
      kind: 'login' as const,
      plan: true,
    }));
    return [...login, ...this.list().flatMap((p) => {
      const notes = new Map(workerChoices(p).map((c) => [c.model, c.note]));
      return (p.workers ?? []).map((model) => ({
        id: workerId(p, model),
        providerId: p.id,
        providerName: p.name,
        model,
        baseUrl: isNative(p) ? ANTHROPIC_API : isCodex(p) || isGoogle(p) ? '' : p.baseUrl,
        auth: isNative(p) ? ('x-api-key' as const) : p.auth,
        note: notes.get(model) ?? `${model} on ${p.name}`,
        agent: (p.agentWorkers ?? []).includes(model),
        ...(p.preset && { preset: p.preset }),
        ...(isCodex(p) && { kind: 'codex' as const, efforts: p.codexModels?.find((x) => x.id === model)?.efforts, images: p.codexImages }),
        ...(isGoogle(p) && { kind: 'google' as const, efforts: p.googleModels?.find((x) => x.id === model)?.efforts, images: p.googleImages, noShell: true, usageScope: p.googleModels?.find((x) => x.id === model)?.usageScope }),
        // Billed to a plan, not per token: spent first by the role templates (roles.ts).
        plan: p.preset === 'zai' || p.preset === 'poe' || isGoogle(p) || (isCodex(p) && p.codexAuth !== 'api-key'),
      }));
    })];
  }

  /** Workers on this account's own Anthropic login: Claude Code, headless, on the subscription. */
  private async editLoginWorkers(): Promise<void> {
    const on = new Set(this.loginWorkers());
    const picked = await vscode.window.showQuickPick(
      Object.entries(LOGIN_WORKER_NOTES).map(([model, note]) => ({ label: model, description: note, picked: on.has(model) })),
      {
        title: "Workers on this account's own Anthropic login",
        placeHolder: 'The lead and agent tasks may consult these. None selected = off.',
        canPickMany: true,
      }
    );
    if (!picked) return;
    const models = picked.map((i) => i.label);
    if (models.some((m) => !on.has(m))) {
      const ok = await vscode.window.showWarningMessage(
        `Let workers run on this account's Anthropic login (${models.join(', ')})?\n\n` +
          `• Each call runs Claude Code itself, headless, on the account's subscription — no tools, no MCP ` +
          `servers, just the task and the material it's given. It counts toward the plan's usage limits.\n` +
          `• Agent tasks on other providers (e.g. GLM) may consult it too.\n` +
          `• Its 5-hour and weekly usage show up in provider_usage after each call.`,
        { modal: true },
        'Allow'
      );
      if (ok !== 'Allow') return;
    }
    await this.setLoginWorkers(models);
    vscode.window.showInformationMessage(models.length ? `Login workers: ${models.join(', ')}. New Claude Code sessions get them.` : 'Login workers are off.');
  }

  /**
   * How to run a worker as an agent task: the provider's settings as a window on
   * it would get them, minus the key — which goes to the run's process only.
   */
  async agentSpec(workerId: string): Promise<AgentRunSpec | undefined> {
    const w = this.workers().find((x) => x.id === workerId && x.agent);
    const p = w && this.list().find((x) => x.id === w.providerId);
    if (!w || !p) return undefined;
    if (isGoogle(p)) {
      const ctx = await this.googleContext(p.id);
      if (!ctx) return undefined;
      // A signed-out `agy -p` doesn't fail: it starts a browser sign-in and hangs. Never launch it signed out.
      if (!(await agySignedIn(ctx))) throw new Error(`Google AI isn't signed in for ${p.name} — sign in under "Edit or Remove a Provider".`);
      return { runner: 'google', runModel: w.model, settings: {}, secretEnv: {}, google: { ctx, models: p.googleModels ?? [] } };
    }
    if (isCodex(p)) {
      const codex = await this.codexContext(p.id);
      return codex ? { runner: 'codex', runModel: w.model, settings: {}, secretEnv: {}, codex } : undefined;
    }
    if (p.extraModels?.includes(w.model)) return undefined; // translated models need the proxy; not for agent tasks
    const key = await this.keyFor(p.id);
    if (!key) return undefined;
    const s = settingsFor(p, key);
    const { ANTHROPIC_AUTH_TOKEN = '', ANTHROPIC_API_KEY = '', ...env } = s.env;
    // The provider's own name for the model (it may carry Claude Code's [1m] marker).
    const runModel =
      Object.values(p.models ?? {}).find((m) => m && m.replace(/(\[1m\])+$/i, '') === w.model) ?? w.model;
    return {
      runModel,
      settings: { ...s.top, env },
      secretEnv: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY },
      ...(ANTHROPIC_API_KEY && { approveKeyTail: ANTHROPIC_API_KEY.trim().slice(-20) }),
    };
  }

  /**
   * WorkerSource: how to run Codex for a Codex provider — its binary, its Codex
   * home (the user's own sign-in for a ChatGPT plan, a private one for an API
   * key) and, for an API key, the key in the run's environment only.
   */
  async codexContext(providerId: string): Promise<CodexContext | undefined> {
    const p = this.list().find((x) => x.id === providerId);
    if (!p || !isCodex(p)) return undefined;
    const bin = await codexBinary();
    if (!bin) return undefined;
    const efforts = Object.fromEntries((p.codexModels ?? []).filter((m) => m.efforts?.length).map((m) => [m.id, m.efforts!]));
    if (p.codexAuth === 'api-key') {
      const key = await this.keyFor(p.id);
      if (!key) return undefined;
      return { bin, home: keyCodexHome(workingRoot(), p.id), env: { CODEX_API_KEY: key }, auth: 'api-key', efforts };
    }
    // A ChatGPT plan: its own sign-in, or — only where the user chose it — this host's.
    const own = !sharesUserCodex(p);
    return { bin, home: own ? keyCodexHome(workingRoot(), p.id) : userCodexHome(), env: {}, auth: 'chatgpt', efforts, own };
  }

  /** WorkerSource: agy uses only this provider's own sign-in, or the host's when chosen. */
  async googleContext(providerId: string): Promise<AgyContext | undefined> {
    const p = this.list().find((x) => x.id === providerId);
    if (!p || !isGoogle(p)) return undefined;
    const bin = await agyBinary();
    if (!bin) return undefined;
    const own = !sharesUserGoogle(p);
    return { bin, home: own ? agyHome(workingRoot(), p.id) : undefined, own };
  }

  googleModels(providerId: string): AgyModel[] {
    return this.list().find((p) => p.id === providerId)?.googleModels ?? [];
  }

  /**
   * Every model this account's providers can serve as a worker, with what each
   * can do and whether it's enabled. Capabilities come from the providers
   * themselves where they say (Codex: `model/list` and its capabilities; a
   * gateway: its model list) and from what each kind of provider supports.
   */
  offers(): ModelOffer[] {
    const out: ModelOffer[] = [];
    const login = new Set(this.loginWorkers());
    for (const [model, note] of Object.entries(LOGIN_WORKER_NOTES)) {
      out.push({
        id: `anthropic-login/${model}`, providerId: '__login__', providerName: LOGIN_PROVIDER, model, note, kind: 'login', plan: true,
        can: { answer: true, agent: false, image: false, vision: true },
        limits: ['agent tasks: not on the login (they run Claude Code on a provider key)'],
        enabled: login.has(model), agentEnabled: false,
      });
    }
    for (const p of this.list()) {
      const on = new Set(p.workers ?? []);
      const agentOn = new Set(p.agentWorkers ?? []);
      const plan = p.preset === 'zai' || p.preset === 'poe' || isGoogle(p) || (isCodex(p) && p.codexAuth !== 'api-key');
      for (const c of workerChoices(p)) {
        const cm = isCodex(p) ? p.codexModels?.find((m) => m.id === c.model) : undefined;
        const image = (isCodex(p) && p.codexImages !== false) || (isGoogle(p) && p.googleImages !== false);
        const limits: string[] = [];
        if (isGoogle(p)) {
          limits.push("agent tasks edit files only — Google AI's agy can't run commands safely (it lets a model retry a refused command outside its sandbox)");
          if (p.googleImages === false) limits.push('images: this account has no image generation');
          else if (p.googleImages === undefined) limits.push('images: not checked yet');
          if (image) limits.push('images: 1024×1024 JPEG, no real transparency');
        }
        if (isCodex(p) && p.codexImages === false) limits.push('images: this account has no image generation');
        if (isCodex(p) && p.codexImages === undefined) limits.push('images: not checked yet');
        out.push({
          id: workerId(p, c.model), providerId: p.id, providerName: p.name, model: c.model, note: c.note,
          ...(isCodex(p) && { kind: 'codex' as const }), ...(isGoogle(p) && { kind: 'google' as const, noShell: true, usageScope: p.googleModels?.find((m) => m.id === c.model)?.usageScope }), ...(p.preset && { preset: p.preset }), plan,
          can: { answer: true, agent: true, image, vision: isGoogle(p) ? /gemini|claude/i.test(c.model) : isCodex(p) ? Boolean(cm?.vision) : /claude/i.test(c.model) || isNative(p) },
          limits,
          enabled: on.has(c.model), agentEnabled: agentOn.has(c.model),
        });
      }
    }
    return out;
  }

  /**
   * Enables models as workers (and, where asked, for agent tasks) — what saving
   * roles that use them needs. One confirmation for all of it, saying where the
   * work goes. False if declined.
   */
  async enableOffers(ids: string[], agentIds: string[]): Promise<boolean> {
    const offers = this.offers();
    const need = offers.filter((o) => (ids.includes(o.id) && !o.enabled) || (agentIds.includes(o.id) && !o.agentEnabled));
    if (need.length === 0) return true;
    const byProvider = new Map<string, ModelOffer[]>();
    for (const o of need) byProvider.set(o.providerName, [...(byProvider.get(o.providerName) ?? []), o]);
    const lines = [...byProvider].map(
      ([name, os]) => `• ${name}: ${os.map((o) => `${o.model}${agentIds.includes(o.id) && !o.agentEnabled ? ' (+ agent tasks)' : ''}`).join(', ')}`
    );
    const agents = need.some((o) => agentIds.includes(o.id) && !o.agentEnabled);
    const ok = await vscode.window.showWarningMessage(
      `Your roles use models that aren't enabled yet. Enable them?\n\n${lines.join('\n')}\n\n` +
        `• The lead decides what to send each one: the task and the code or text it pastes in goes to that provider ` +
        `(billed to its key, or counted toward its plan).\n` +
        (agents
          ? `• Agent tasks run that model headless in a scratch git worktree of your repo — reading and editing files ` +
            `there (Google AI: edit-only, no shell; Claude Code: auto mode; Codex: commands in its sandbox). Nothing reaches your ` +
            `working tree unless the lead applies the diff.\n`
          : '') +
        `• Off again any time under "Edit or Remove a Provider → Workers".`,
      { modal: true },
      'Enable and save'
    );
    if (ok !== 'Enable and save') return false;
    const loginAdd = need.filter((o) => o.kind === 'login').map((o) => o.model);
    if (loginAdd.length) await this.setLoginWorkers([...new Set([...this.loginWorkers(), ...loginAdd])]);
    const list = this.list().map((p) => {
      const mine = need.filter((o) => o.providerId === p.id);
      if (mine.length === 0) return p;
      const workers = new Set(p.workers ?? []);
      const agentsOn = new Set(p.agentWorkers ?? []);
      for (const o of mine) {
        workers.add(o.model);
        if (agentIds.includes(o.id)) agentsOn.add(o.model);
      }
      return { ...p, workers: [...workers], agentWorkers: agentsOn.size ? [...agentsOn] : undefined };
    });
    await this.save(list);
    log(`orchestration: enabled ${need.map((o) => o.id).join(', ')}`);
    this.onDidChange.fire();
    return true;
  }

  /** Refresh Google's catalog quietly; check image generation only until it is known. */
  async ensureGoogleFacts(): Promise<void> {
    for (const p of this.list()) {
      if (!isGoogle(p)) continue;
      const ctx = await this.googleContext(p.id);
      if (!ctx) {
        void this.noticeMissingGoogle();
        continue;
      }
      const catalog = await agyModels(ctx);
      if (!catalog.signedIn) continue;
      const images = p.googleImages ?? await agyImageSupport(ctx, catalog.models);
      await this.save(this.list().map((x) => x.id === p.id ? { ...x, googleModels: catalog.models, ...(images !== undefined && { googleImages: images }) } : x));
    }
  }

  /** Codex facts older versions didn't record (image generation, vision), read quietly once. */
  async ensureCodexFacts(): Promise<void> {
    for (const p of this.list()) {
      if (!isCodex(p) || (p.codexImages !== undefined && p.codexModels?.every((m) => m.vision !== undefined))) continue;
      const ctx = await this.codexContext(p.id);
      if (!ctx) continue;
      const [models, caps] = await Promise.all([codexModels(ctx), codexCapabilities(ctx)]);
      const updated: Provider = { ...p, codexModels: models, ...(caps && { codexImages: caps.imageGeneration }) };
      await this.save(this.list().map((x) => (x.id === p.id ? updated : x)));
      log(`provider ${p.name}: Codex ${caps?.imageGeneration ? 'can' : 'cannot'} generate images; ${models.filter((m) => m.vision).length} models take images`);
    }
  }

  /**
   * WorkerSource: where Claude Code caches this account's plan usage — this
   * window's own config dir, the account's store, and the other windows' dirs
   * (filtered to this account by email when read).
   */
  claudeUsageDirs(): { dirs: string[]; email?: string } {
    const own = this.binding.getEnvDir();
    const dirs = [own, this.loginDir(), ...allWorkingDirs()].filter((d): d is string => Boolean(d));
    return { dirs: [...new Set(dirs)], email: this.email() };
  }

  /**
   * What Claude Parallel Accounts (CPPO's old name) left where CPPO can't read
   * it — VS Code keeps secrets and per-window state per extension:
   *  - provider keys: recovered from this account's window settings.json files,
   *    which hold a copy for Claude Code (a gateway or Anthropic key); the rest
   *    are asked for (promptMissingKeys);
   *  - this window's provider: recognised from its settings.json (the gateway's
   *    URL, or the local proxy's port).
   * Harmless when there's nothing to adopt.
   */
  async adoptFromOldExtension(): Promise<void> {
    const email = this.email();
    if (!email) return;
    const windows = allWorkingDirs()
      .map((dir) => {
        let env: Record<string, string> = {};
        try {
          env = ((JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')) as { env?: Record<string, string> }).env) ?? {};
        } catch {
          /* no settings */
        }
        return { dir, env, email: readIdentity(dir)?.email };
      })
      .filter((w) => w.email === email && w.env.ANTHROPIC_BASE_URL);
    const norm = (u: string) => u.trim().replace(/\/+$/, '');
    const natives = this.list().filter(isNative);
    const servedBy = (p: Provider, env: Record<string, string>): boolean => {
      const base = norm(env.ANTHROPIC_BASE_URL ?? '');
      const port = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(base)?.[1];
      if (port) return Number(port) === proxyPort(p.id);
      if (isNative(p)) return base === ANTHROPIC_API && Boolean(env.ANTHROPIC_API_KEY) && natives.length === 1;
      return !isCodex(p) && !isGoogle(p) && base === norm(p.baseUrl);
    };
    for (const p of this.list()) {
      if (isGoogle(p) || (isCodex(p) && p.codexAuth !== 'api-key') || (await this.keyFor(p.id))) continue;
      for (const w of windows) {
        if (/^http:\/\/127\.0\.0\.1:/.test(w.env.ANTHROPIC_BASE_URL)) continue; // holds the proxy's key, not the provider's
        const key = servedBy(p, w.env) ? (isNative(p) ? w.env.ANTHROPIC_API_KEY : w.env.ANTHROPIC_AUTH_TOKEN || w.env.ANTHROPIC_API_KEY) : '';
        if (key) {
          await this.context.secrets.store(this.secretKey(p.id), key);
          log(`provider ${p.name}: key recovered from a window's settings (left by Claude Parallel Accounts)`);
          break;
        }
      }
    }
    if (!this.context.workspaceState.get<string>(ACTIVE_KEY) && this.settingsFile()) {
      const own = windows.find((w) => path.normalize(w.dir) === path.normalize(path.dirname(this.settingsFile()!)));
      const p = own && this.list().find((x) => chatCapable(x) && servedBy(x, own.env));
      if (p) {
        await this.context.workspaceState.update(ACTIVE_KEY, p.id);
        log(`provider: this window runs ${p.name} (set up by Claude Parallel Accounts)`);
        this.onDidChange.fire();
      }
    }
  }

  /** Providers whose key CPPO doesn't have (kept with the old extension): asked for, once per window. */
  async promptMissingKeys(): Promise<void> {
    const missing: Provider[] = [];
    for (const p of this.list()) {
      if (isGoogle(p) || (isCodex(p) && p.codexAuth !== 'api-key')) continue; // the CLI's own sign-in
      if (!(await this.keyFor(p.id))) missing.push(p);
    }
    if (missing.length === 0) return;
    const pick = await vscode.window.showWarningMessage(
      `CPPO needs ${missing.length === 1 ? 'a key' : `${missing.length} keys`} again — ${missing.map((p) => p.name).join(', ')}. ` +
        `VS Code kept ${missing.length === 1 ? 'it' : 'them'} with Claude Parallel Accounts, CPPO's old name, where CPPO can't read ${missing.length === 1 ? 'it' : 'them'}.`,
      'Enter keys',
      'Not now'
    );
    if (pick !== 'Enter keys') return;
    for (const p of missing) {
      const key = (
        await vscode.window.showInputBox({
          title: `Key for ${p.name}`,
          prompt: isCodex(p) ? 'Your OpenAI API key (platform.openai.com/api-keys)' : isNative(p) ? 'Your Anthropic API key' : `The key for ${describeKind(p)}`,
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : 'Enter the key'),
        })
      )?.trim();
      if (!key) continue;
      await this.context.secrets.store(this.secretKey(p.id), key);
      log(`provider ${p.name}: key entered again`);
    }
    this.onDidChange.fire();
    await this.sync();
  }

  /** WorkerSource: this account's roles on this host, as the orchestration panel saved them. */
  rolePolicy(): RolePolicy | undefined {
    const email = this.email();
    return email ? this.state.get<Record<string, RolePolicy>>('claudeProfiles.roles', {})[email] : undefined;
  }

  /** Saves this account's roles (undefined = back to the template). */
  async saveRolePolicy(policy: RolePolicy | undefined): Promise<void> {
    const email = this.email();
    if (!email) throw new Error('This window has no signed-in account — roles belong to an account.');
    const all = this.state.get<Record<string, RolePolicy>>('claudeProfiles.roles', {});
    if (policy) all[email] = policy;
    else delete all[email];
    await this.state.update('claudeProfiles.roles', all);
    this.onDidChange.fire();
  }

  /** WorkerSource: the provider's key, read from secret storage per call. */
  keyFor(providerId: string): Promise<string | undefined> {
    return Promise.resolve(this.context.secrets.get(this.secretKey(providerId)));
  }

  /**
   * Writes the provider's settings into this window's settings.json, or removes
   * them for the Anthropic login. Leaves the rest of the file alone — Claude Code's
   * /config writes there too. Returns true if the file changed.
   */
  private async writeSettings(desired: ProviderSettings | undefined): Promise<boolean> {
    const file = this.settingsFile();
    if (!file) throw new Error('This window has no account of its own yet — sign in or pick an account first.');
    const stash = this.context.workspaceState.get<Record<string, unknown>>(STASH_KEY);
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      } catch (err) {
        // Never overwrite a file we can't read — it may hold the user's own settings.
        throw new Error(`Can't read ${file} (${(err as Error).message}). Fix or remove it, then try again.`);
      }
    } else if (!desired) {
      if (stash) await this.context.workspaceState.update(STASH_KEY, undefined);
      return false; // Anthropic login, and nothing was ever written
    }
    const before = JSON.stringify(settings);

    const env = { ...((settings.env as Record<string, string> | undefined) ?? {}) };
    for (const k of MANAGED_ENV) delete env[k];
    Object.assign(env, desired?.env ?? {});
    if (Object.keys(env).length > 0) settings.env = env;
    else delete settings.env;

    if (desired && !desired.keepTop) {
      // Coming from the Anthropic login: keep the window's own values to put back.
      if (!stash) {
        const own = Object.fromEntries(MANAGED_TOP.filter((k) => k in settings).map((k) => [k, settings[k]]));
        await this.context.workspaceState.update(STASH_KEY, own);
      }
      for (const k of MANAGED_TOP) delete settings[k];
      Object.assign(settings, desired.top);
    } else if (stash) {
      for (const k of MANAGED_TOP) delete settings[k];
      Object.assign(settings, stash);
      await this.context.workspaceState.update(STASH_KEY, undefined);
    }

    // Going to Anthropic (the login or an API key): a default model only a gateway
    // serves — `/model` → glm-5.3, saved by Claude Code — would be sent to
    // Anthropic and fail. Claude aliases and IDs stay.
    if ((!desired || desired.keepTop) && typeof settings.model === 'string' && !isClaudeModel(settings.model)) {
      log(`provider: dropped default model "${settings.model}", which Anthropic doesn't serve`);
      delete settings.model;
    }
    if (desired?.env.ANTHROPIC_API_KEY) approveApiKey(path.dirname(file), desired.env.ANTHROPIC_API_KEY);
    if (JSON.stringify(settings) === before) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the file now holds a key
    fs.renameSync(tmp, file);
    return true;
  }

  /**
   * Re-reads the provider's model list when it's missing or older than a day.
   * Best effort: a gateway that's down, or has no /v1/models, keeps the list it
   * had (or none — the manual aliases still apply).
   */
  private async refreshCatalog(provider: Provider, key: string, force = false): Promise<Provider> {
    if (!readsCatalog(provider)) return provider; // Anthropic itself, or a preset with fixed models
    // A list read before non-Claude models existed (≤ 1.5) has no otherCatalog: re-read it now.
    const fresh = provider.catalogAt && Date.now() - provider.catalogAt < CATALOG_TTL_MS && provider.otherCatalog;
    if (!force && fresh) return provider;
    try {
      const { claude: catalog, others } = await fetchCatalog(provider.baseUrl, provider.auth, key);
      const updated: Provider = { ...provider, catalog, otherCatalog: others, catalogAt: Date.now() };
      await this.save(this.list().map((p) => (p.id === provider.id ? updated : p)));
      log(
        `provider ${provider.name}: ${catalog.length} Claude models on /v1/messages (${describeModels(updated)}), ` +
          `${others.length} others usable through the proxy`
      );
      return updated;
    } catch (err) {
      log(`provider ${provider.name}: could not read the model list — ${(err as Error).message}`);
      if (force) throw err;
      return provider;
    }
  }

  private lockFile(): string {
    return path.join(this.context.extensionPath, 'litellm', 'requirements.lock');
  }

  /**
   * The provider's proxy, when it routes through one. Installing LiteLLM is a big,
   * one-time step (~600 MB), so it only happens on an explicit yes: `interactive`
   * asks; otherwise a missing install means no proxy and the caller falls back to
   * the gateway's Claude models only.
   */
  private async proxyFor(p: Provider, key: string, interactive: boolean): Promise<ProxyHandle | undefined> {
    if (!p.extraModels?.length) return undefined;
    if (!isInstalled(this.lockFile())) {
      if (!interactive) return undefined;
      const ok = await vscode.window.showWarningMessage(
        `Running non-Claude models needs a local LiteLLM proxy. Install it on this host now?\n\n` +
          `• Into ~/.claude-windows/litellm (about 600 MB), with uv or Python 3.10+.\n` +
          `• Every package pinned by hash — a tampered download fails instead of installing.\n` +
          `• Listens on 127.0.0.1 only; your ${p.name} key stays in its memory, never in a file.\n` +
          `• Uninstalling this extension removes it.`,
        { modal: true },
        'Install'
      );
      if (ok !== 'Install') return undefined;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing LiteLLM (hash-verified)…' },
        () => install(this.lockFile())
      );
    }
    const config = proxyConfig(proxyBase(p), p.auth, claudeGatewayIds(p), p.extraModels);
    return interactive
      ? vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Starting the local proxy for ${p.name}…` },
          () => ensureProxy(p.id, config, key, path.join(this.context.extensionPath, 'litellm', 'schema_fix.py'), this.version())
        )
      : ensureProxy(p.id, config, key, path.join(this.context.extensionPath, 'litellm', 'schema_fix.py'), this.version());
  }

  /** Points this window at `provider` (undefined = its Anthropic login) and reloads it. */
  private async useInWindow(provider: Provider | undefined): Promise<void> {
    let desired: ProviderSettings | undefined;
    if (provider && isGoogle(provider)) {
      throw new Error(`${provider.name} runs on your Google AI plan, which only Antigravity itself may use — it can't serve a chat window.`);
    }
    if (provider && !chatCapable(provider)) {
      throw new Error(`${provider.name} runs on your ChatGPT plan, which only Codex itself may use — it can't serve a chat window. Add OpenAI Codex with an API key for that.`);
    }
    if (provider && isCodex(provider) && !provider.extraModels?.length) {
      const picked = await this.pickChatModels(provider);
      if (!picked?.extraModels?.length) return;
      await this.save(this.list().map((p) => (p.id === picked.id ? picked : p)));
      provider = picked;
    }
    if (provider) {
      const key = await this.context.secrets.get(this.secretKey(provider.id));
      if (!key) throw new Error(`No key is stored for ${provider.name}. Edit the provider and set its key.`);
      provider = await this.refreshCatalog(provider, key);
      const proxy = await this.proxyFor(provider, key, true);
      if (isCodex(provider) && !proxy) return; // LiteLLM declined or not installed: nothing changes
      desired = settingsFor(provider, key, proxy);
    }
    await this.writeSettings(desired);
    await this.context.workspaceState.update(ACTIVE_KEY, provider?.id);
    log(`provider: this window now bills to ${provider ? `${provider.name} (${proxyBase(provider)})` : 'its Anthropic login'}`);
    this.onDidChange.fire();
    // Claude Code keeps a long-lived process that read its env when it started;
    // only a reload makes the panel itself pick the change up.
    await this.context.workspaceState.update(
      NOTICE_KEY,
      provider
        ? `This window now bills to ${provider.name}. Your Anthropic login stays saved — switch back any time from the status bar.`
        : `This window is back on its Anthropic login (${describeLogin(this.binding.getEnvDir())}).`
    );
    try {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch {
      /* the reload tears this command down mid-call ("Canceled") — that IS the success */
    }
  }

  /**
   * Brings settings.json in line with the provider's CURRENT definition and key.
   * Definitions are shared, so another window — or another host — may have
   * edited or removed the one this window uses. Never reloads by itself: it
   * offers the reload, so this can't become a loop.
   */
  async sync(): Promise<void> {
    // Until this host has adopted the shared providers, a window's provider can't
    // be found yet — acting now would reset it to the Anthropic login.
    if (!this.state.get<boolean>('claudeProfiles.providersMigrated')) return;
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (!id || !this.settingsFile()) return;
    let provider = this.get(id);
    if (provider && provider.id !== id) await this.context.workspaceState.update(ACTIVE_KEY, provider.id);
    const key = provider ? await this.context.secrets.get(this.secretKey(provider.id)) : undefined;
    if (provider && !key) {
      // No key here (e.g. kept with CPPO's old name): the window's settings still work —
      // leave them until the key is entered again (promptMissingKeys), don't drop the provider.
      log(`provider sync: ${provider.name} has no key stored for CPPO yet — this window's settings are left as they are`);
      return;
    }
    if (provider && key) provider = await this.refreshCatalog(provider, key);
    let changed: boolean;
    try {
      // The proxy may be down — after a reboot, or another window changed its
      // models — and this is what brings it back before the window needs it.
      let proxy: ProxyHandle | undefined;
      if (provider && key) {
        try {
          proxy = await this.proxyFor(provider, key, false);
        } catch (err) {
          log(`provider sync: proxy for ${provider.name} failed — ${(err as Error).message}`);
        }
      }
      changed = await this.writeSettings(provider && key ? settingsFor(provider, key, proxy) : undefined);
    } catch (err) {
      log(`provider sync failed: ${(err as Error).message}`);
      return;
    }
    if (!provider || !key) {
      await this.context.workspaceState.update(ACTIVE_KEY, undefined);
      this.onDidChange.fire();
    }
    if (!changed) return;
    const what = !provider
      ? 'The provider this window used was removed, so it is back on its Anthropic login.'
      : !key
        ? `${provider.name} has no stored key any more, so this window is back on its Anthropic login.`
        : `${provider.name}'s settings changed.`;
    log(`provider sync: ${what}`);
    const pick = await vscode.window.showInformationMessage(
      `CPPO: ${what} Reload the window to apply it to the Claude Code panel.`,
      'Reload window'
    );
    if (pick === 'Reload window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * `claudeCode.environmentVariables` is one setting for every window. A gateway
   * credential there doesn't beat a provider picked here (settings.json env wins
   * over the process env), but it DOES silently replace the Anthropic login in every
   * window set to use it. Warn rather than strip: unlike CLAUDE_CONFIG_DIR, it may
   * well be deliberate.
   */
  warnAboutSharedOverride(): void {
    if (this.context.globalState.get<boolean>(HIDE_OVERRIDE_WARNING_KEY)) return;
    const vars = vscode.workspace
      .getConfiguration('claudeCode')
      .get<Array<{ name: string; value: string }>>('environmentVariables', []);
    const found = vars
      .map((v) => v.name)
      .filter((n) => n === 'ANTHROPIC_AUTH_TOKEN' || n === 'ANTHROPIC_API_KEY' || n === 'ANTHROPIC_BASE_URL');
    if (found.length === 0) return;
    log(`claudeCode.environmentVariables sets ${found.join(', ')} for every window`);
    void vscode.window
      .showWarningMessage(
        `CPPO: the claudeCode.environmentVariables setting sets ${found.join(', ')} for EVERY ` +
          `window, so windows on "Anthropic" won't use their Anthropic login. Add it as a provider ` +
          `instead to choose it per window.`,
        'Open setting',
        "Don't show again"
      )
      .then((pick) => {
        if (pick === 'Open setting') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCode.environmentVariables');
        } else if (pick === "Don't show again") {
          void this.context.globalState.update(HIDE_OVERRIDE_WARNING_KEY, true);
        }
      });
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  async switchInteractive(): Promise<void> {
    if (!this.settingsFile()) {
      vscode.window.showInformationMessage(
        'CPPO: this window has no account of its own yet. Sign in with Claude Code (or pick a ' +
          'saved account), then choose a provider.'
      );
      return;
    }
    const current = this.active();
    type Item = vscode.QuickPickItem & { provider?: Provider; add?: boolean };
    const mark = (on: boolean) => (on ? '$(check) ' : '');
    const items: Item[] = [
      {
        label: `${mark(!current)}Anthropic`,
        description: describeLogin(this.binding.getEnvDir()),
        detail: 'Default — this account\'s own login, straight to Anthropic',
      },
      // A ChatGPT plan is Codex's own: workers only. An OpenAI API key goes through the proxy.
      ...this.list().filter(chatCapable).map((p) => ({
        label: `${mark(current?.id === p.id)}${p.name}`,
        description: isNative(p)
          ? 'Anthropic API key, billed per token'
          : isCodex(p)
            ? 'OpenAI API key, billed per token · GPT through the local proxy'
            : p.preset
              ? PRESETS[p.preset].label
              : p.baseUrl,
        provider: p,
      })),
      { label: '$(add) Add a provider…', add: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Bill this window to… (reloads the window)',
      placeHolder: 'Your account, history and settings stay the same — only where requests go changes',
    });
    if (!picked) return;
    if (picked.add) {
      await this.addInteractive();
      return;
    }
    if (picked.provider?.id === current?.id) {
      vscode.window.showInformationMessage(`This window already bills to ${current?.name ?? 'its Anthropic login'}.`);
      return;
    }
    await this.useInWindow(picked.provider);
  }

  /** Runs testProvider with progress; a failure is reported here, a success left to the caller. */
  private async testInteractive(p: Provider, key: string): Promise<TestResult> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${p.name}…` },
      () => testProvider(p, key)
    );
    if (r.ok) {
      log(`provider ${p.name}: test OK (${r.model}, ${r.ms} ms)`);
      return r;
    }
    log(`provider ${p.name}: test FAILED (${r.model}) ${r.status ?? ''} ${r.message}`);
    vscode.window.showWarningMessage(
      `${p.name} didn't answer a test request${r.status ? ` (HTTP ${r.status})` : ''}: ${r.message}\n\n${r.hint}`,
      { modal: true }
    );
    return r;
  }

  /** After adding: test it, then offer it for this window (a failed test still allows it, with a warning). */
  private async offerNewProvider(p: Provider, key: string, what: string): Promise<void> {
    const { ok } = await this.testInteractive(p, key);
    const canUse = Boolean(this.settingsFile());
    const msg = ok
      ? `Added ${p.name}: ${what}`
      : `Added ${p.name}, but its test failed — fix it under "Edit or Remove a Provider" (Replace key, Test connection).`;
    const pick = await (ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(
      msg,
      ...(canUse ? [ok ? 'Use in this window' : 'Use in this window anyway'] : [])
    );
    if (pick) await this.useInWindow(p);
  }

  async addInteractive(): Promise<void> {
    type Choice = 'anthropic' | GatewayPreset | 'codex' | 'google' | 'custom';
    const choice = (
      await vscode.window.showQuickPick<vscode.QuickPickItem & { choice: Choice }>(
        [
          {
            label: '$(key) Anthropic API key',
            detail: 'A key from console.anthropic.com — straight to Anthropic, billed per token',
            choice: 'anthropic',
          },
          ...(Object.keys(PRESETS) as GatewayPreset[]).map((id) => ({
            label: `$(server) ${PRESETS[id].label}`,
            description: PRESETS[id].baseUrl,
            detail: PRESETS[id].detail,
            choice: id,
          })),
          {
            label: '$(hubot) OpenAI Codex',
            description: 'workers and agent tasks',
            detail: 'GPT through the Codex CLI on your ChatGPT plan or an OpenAI API key — and, with an API key, in chat windows too (local proxy)',
            choice: 'codex',
          },
          {
            label: '$(hubot) Google AI (Antigravity)',
            description: 'workers and edit-only agent tasks',
            detail: 'Gemini and other models through agy on your Google AI plan — only Antigravity uses its sign-in; CPPO never reads it. Gemini API keys bill separately.',
            choice: 'google',
          },
          {
            label: '$(gear) Custom Anthropic-compatible gateway',
            detail: 'A company proxy or any other endpoint — a base URL and a key',
            choice: 'custom',
          },
        ],
        { title: 'Add a provider' }
      )
    )?.choice;
    if (!choice) return;
    if (choice === 'anthropic') return this.addAnthropicKey();
    if (choice === 'codex') return this.addCodex();
    if (choice === 'google') return this.addGoogle();
    return this.addGateway(choice === 'custom' ? undefined : choice);
  }

  /** A gateway: a preset fills in the URL, key header and models, so only a name and key are asked. */
  private async addGateway(presetId?: GatewayPreset): Promise<void> {
    const preset = presetId ? PRESETS[presetId] : undefined;
    const steps = preset ? 2 : 4;
    const taken = (v: string) => this.list().some((p) => p.name === v.trim());
    const name = await vscode.window.showInputBox({
      title: `Add ${preset?.label ?? 'a provider'} (1/${steps}): name`,
      prompt: 'Shown in the status bar',
      value: preset && !taken(preset.name) ? preset.name : '',
      validateInput: (v) => (!v.trim() ? 'Enter a name' : taken(v) ? 'That name is taken' : undefined),
    });
    if (!name) return;
    let baseUrl = preset?.baseUrl;
    let auth = preset?.auth;
    if (!preset) {
      baseUrl = await vscode.window.showInputBox({
        title: 'Add a provider (2/4): base URL',
        prompt: 'The Anthropic-compatible endpoint',
        value: 'https://',
        validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
      });
      if (!baseUrl) return;
      auth = await this.pickAuth();
      if (!auth) return;
    }
    const key = await vscode.window.showInputBox({
      title: `Add ${preset?.label ?? 'a provider'} (${steps}/${steps}): key`,
      prompt: `${preset?.keyHint ? `${preset.keyHint}. ` : ''}Stored in VS Code's secret storage on this computer`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter the key'),
    });
    if (!key) return;

    const provider: Provider = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim(),
      baseUrl: baseUrl!.trim().replace(/\/+$/, ''),
      auth: auth!,
      ...(presetId && { preset: presetId }),
      ...(preset?.models && { models: { ...preset.models } }),
    };
    if (!(await this.termsCheck(provider))) return;
    await this.context.secrets.store(this.secretKey(provider.id), key.trim());
    await this.save([...this.list(), provider]);
    log(`provider added: ${provider.name} (${provider.baseUrl}, ${provider.auth}${presetId ? `, preset ${presetId}` : ''})`);

    let added = provider;
    let found: string;
    if (!readsCatalog(provider)) {
      found = `models: ${describeModels(provider)}.`;
    } else {
      // Read what the gateway serves, so the picker shows exactly that.
      try {
        added = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Reading ${provider.name}'s model list…` },
          () => this.refreshCatalog(provider, key.trim(), true)
        );
        found = added.catalog?.length
          ? `${added.catalog.length} Claude models usable from Claude Code — ${describeModels(added)}.`
          : `no Claude models it serves to Claude Code were found. Set model aliases under "Edit or Remove a Provider".`;
      } catch (err) {
        found =
          `its model list couldn't be read (${(err as Error).message}). Set model aliases under ` +
          `"Edit or Remove a Provider".`;
      }
    }

    await this.offerNewProvider(added, key.trim(), found);
  }

  /**
   * Before adding a provider: if THIS Claude account already has one of the same
   * service, say plainly that several accounts or keys with one service, used to
   * get around its limits, can break its terms. Other Claude accounts on the host
   * don't count — a work account and a personal one are separate purposes. Two
   * Codex or Google AI providers sharing the host sign-in use one service account, not two.
   * The user decides. False if they cancel.
   */
  private async termsCheck(p: Provider): Promise<boolean> {
    const svc = serviceOf(p);
    const existing = this.list().filter(
      (x) => x.id !== p.id && serviceOf(x).key === svc.key && !(sharesUserCodex(p) && sharesUserCodex(x)) && !(sharesUserGoogle(p) && sharesUserGoogle(x))
    );
    if (existing.length === 0) return true;
    const what = isGoogle(p) ? 'Google AI account' : isCodex(p) && p.codexAuth !== 'api-key' ? 'ChatGPT account' : 'key';
    log(`provider: another ${svc.label} ${what} in this Claude account (already: ${existing.map((x) => x.name).join(', ')}) — terms warning shown`);
    const ok = await vscode.window.showWarningMessage(
      `This Claude account already has ${svc.label}: ${existing.map((x) => `"${x.name}"`).join(', ')}.\n\n` +
        `Using more than one ${svc.label} ${what} — for example, to get around a plan's usage limits — ` +
        `may break ${svc.label}'s terms of service. This extension doesn't check or work around anyone's terms; ` +
        `make sure what you're doing is allowed.`,
      { modal: true },
      'Add it anyway'
    );
    return ok === 'Add it anyway';
  }

  /**
   * agy's path. When it's missing: say what the installer needs that this host
   * lacks, offer the install command in a terminal (shown, never run for the user)
   * and wait for them to say it's done. Undefined if they give up.
   */
  private async ensureAgy(why: string): Promise<string | undefined> {
    for (;;) {
      const bin = await agyBinary();
      if (bin) return bin;
      const blockers = await agyInstallBlockers();
      const pick = await vscode.window.showWarningMessage(
        `${why} Google AI runs through Antigravity's CLI (agy), which isn't on this host.` +
          (blockers.length ? ` Its installer needs ${blockers.join(', ')}, which this host lacks — install that first.` : ' CPPO shows the installer in a terminal and never runs it for you.'),
        ...(blockers.length ? ['Check again'] : ['Open install terminal', 'Check again'])
      );
      if (pick === 'Open install terminal') {
        const t = vscode.window.createTerminal('Install Antigravity');
        t.show();
        t.sendText(AGY_INSTALL_COMMAND, false);
        if (!(await vscode.window.showInformationMessage('Press Enter in the terminal to run the installer. When it has finished, choose Check again.', 'Check again'))) return undefined;
      } else if (pick !== 'Check again') return undefined;
    }
  }

  private missingGoogleNoticed = false;

  /** A Google AI provider exists but agy is gone from this host: say so once a session, with the install offer. */
  async noticeMissingGoogle(): Promise<void> {
    if (this.missingGoogleNoticed || !this.list().some(isGoogle) || (await agyBinary())) return;
    this.missingGoogleNoticed = true;
    if (await this.ensureAgy("Your Google AI provider can't run.")) this.onDidChange.fire();
  }

  /** Google AI plans are used only by Antigravity itself; CPPO never reads its sign-in. */
  private async addGoogle(): Promise<void> {
    const bin = await this.ensureAgy('Adding Google AI needs it.');
    if (!bin) return;
    const users = this.sharedGoogleUsers();
    const home = (await vscode.window.showQuickPick([
      { label: '$(shield) Its own Google AI sign-in (recommended)', detail: 'A private HOME for this provider alone — keep personal and work sign-ins separate. Only Antigravity uses the plan; CPPO never reads its sign-in.', mode: 'own' as const },
      { label: "$(account) This host's Google AI sign-in", detail: `One sign-in per Linux user, whatever Claude account is active${users.length ? `; also used by ${users.join(', ')}` : ''}.`, mode: 'shared' as const },
    ], { title: 'Add Google AI: whose sign-in?' }))?.mode;
    if (!home) return;
    let orphan: { id: string; dir: string } | undefined;
    if (home === 'own') {
      const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
      const referenced = new Set(Object.values(all).flatMap((list) => list.map((p) => p.id)));
      const found = findOrphanAgyHomes(workingRoot(), referenced);
      if (found.length) {
        const pick = await vscode.window.showQuickPick([
          { label: '$(add) A new sign-in', description: 'Sign in for this provider alone', orphan: undefined as typeof orphan },
          ...found.map((o) => ({ label: `$(account) Reuse ${o.id}`, description: 'An existing private sign-in no provider references', orphan: o })),
        ], { title: 'Add Google AI: reuse a sign-in found on this host?' });
        if (!pick) return;
        orphan = pick.orphan;
      }
    }
    const name = await vscode.window.showInputBox({
      title: 'Add Google AI: name', value: 'Google AI',
      prompt: "How workers on it are named and shown in the account's hover",
      validateInput: (v) => !v.trim() ? 'Enter a name' : this.list().some((p) => p.name === v.trim()) ? 'That name is taken' : undefined,
    });
    if (!name) return;
    const p: Provider = { id: crypto.randomBytes(6).toString('hex'), name: name.trim(), kind: 'google', googleHome: home, baseUrl: '', auth: 'bearer' };
    if (!await this.termsCheck(p)) return;
    if (orphan) {
      const target = agyHome(workingRoot(), p.id);
      fs.rmdirSync(target);
      fs.renameSync(orphan.dir, target);
      log(`provider ${p.name}: reusing the Google AI sign-in found in ${orphan.id}`);
    }
    await this.save([...this.list(), p]);
    log(`provider added: ${p.name} (Google AI, ${home} sign-in, ${bin})`);
    this.onDidChange.fire();
    if (!await this.checkGoogle(p)) return;
    await this.ensureGoogleFacts();
    const fresh = this.list().find((x) => x.id === p.id)!;
    const updated = await this.pickWorkers(fresh);
    if (updated) await this.save(this.list().map((x) => x.id === p.id ? updated : x));
    this.onDidChange.fire();
    vscode.window.showInformationMessage(`Added ${p.name}. Pick its workers any time under "Edit or Remove a Provider".`);
  }

  /** Free sign-in/catalog check: never send a prompt to test a connection. */
  private async checkGoogle(p: Provider): Promise<boolean> {
    const ctx = await this.googleContext(p.id);
    if (!ctx) return (await this.ensureAgy(`${p.name}:`)) ? this.checkGoogle(p) : false;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${p.name}…` }, () => agyModels(ctx));
    if (r.signedIn) {
      await this.save(this.list().map((x) => x.id === p.id ? { ...x, googleModels: r.models } : x));
      this.onDidChange.fire();
      log(`provider ${p.name}: Google AI signed in — ${r.models.map((m) => m.id).join(', ')}`);
      vscode.window.showInformationMessage(`${p.name}: signed in · ${r.models.length} models (${r.models.map((m) => m.name).join(', ')}).`);
      return true;
    }
    const pick = await vscode.window.showWarningMessage(`${p.name}: not signed in. ${r.message ?? 'Sign in with agy, then check again.'}`, 'Sign in to Google AI', 'Check again');
    if (pick === 'Sign in to Google AI') return this.signInGoogle(p);
    if (pick === 'Check again') return this.checkGoogle(p);
    return false;
  }

  private async signInGoogle(p: Provider): Promise<boolean> {
    const ctx = await this.googleContext(p.id);
    if (!ctx) return false;
    const t = vscode.window.createTerminal('Sign in to Google AI');
    t.show();
    t.sendText(agySignInCommand(ctx));
    const pick = await vscode.window.showInformationMessage(
      `Finish signing in to Google AI in the terminal, then leave agy or close that terminal once it shows you signed in.${ctx.own ? ' The browser it opens may be a fresh profile for this private sign-in.' : ''} Only Antigravity uses your plan; CPPO never reads its sign-in.`,
      'Check again'
    );
    return pick === 'Check again' ? this.checkGoogle(p) : false;
  }

  private sharedGoogleUsers(): string[] {
    const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
    return Object.entries(all).flatMap(([email, list]) => list.filter(sharesUserGoogle).map((p) => `"${p.name}" (${email})`));
  }

  private async setGoogleHome(p: Provider, mode: 'own' | 'shared'): Promise<void> {
    const updated = { ...p, googleHome: mode, googleModels: undefined, googleImages: undefined };
    await this.save(this.list().map((x) => x.id === p.id ? updated : x));
    const ack = this.state.get<Record<string, boolean>>('claudeProfiles.googleSharedAck', {});
    if (mode === 'shared') ack[p.id] = true;
    else delete ack[p.id];
    await this.state.update('claudeProfiles.googleSharedAck', ack);
    if (mode === 'shared') fs.rmSync(path.join(workingRoot(), 'agy', p.id), { recursive: true, force: true });
    this.onDidChange.fire();
    if (await this.checkGoogle(updated)) await this.ensureGoogleFacts();
  }

  /** Offer separate sign-ins when work and personal Claude accounts share this Linux user's Google sign-in. */
  async noticeSharedGoogle(): Promise<void> {
    const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
    const shared = Object.entries(all).flatMap(([email, list]) => list.filter(sharesUserGoogle).map((p) => ({ p, email })));
    if (new Set(shared.map((s) => s.email)).size < 2) return;
    const ack = this.state.get<Record<string, boolean>>('claudeProfiles.googleSharedAck', {});
    for (const p of this.list().filter((x) => sharesUserGoogle(x) && !ack[x.id])) {
      const others = shared.filter((s) => s.email !== this.email()).map((s) => `"${s.p.name}" (${s.email})`);
      const pick = await vscode.window.showWarningMessage(
        `${p.name} uses this host's one Google AI sign-in, which ${others.join(', ')} — under another Claude account — uses too. ` +
          `That's whichever Google AI account agy is signed in as, for every Claude account on this Linux user. If these are meant to be ` +
          `different accounts (a work one and a personal one), give ${p.name} its own sign-in.`,
        'Give it its own sign-in', 'Keep sharing'
      );
      if (pick === 'Give it its own sign-in') await this.setGoogleHome(p, 'own');
      else if (pick === 'Keep sharing') {
        ack[p.id] = true;
        await this.state.update('claudeProfiles.googleSharedAck', ack);
      }
    }
  }

  /**
   * OpenAI Codex: GPT through the Codex CLI, for workers and agent tasks. A
   * ChatGPT plan is used only by Codex itself (signed in with `codex login`); an
   * API key reaches Codex's runs through their environment, never a file.
   */
  private async addCodex(): Promise<void> {
    const bin = await codexBinary();
    if (!bin) {
      const pick = await vscode.window.showWarningMessage(
        'OpenAI Codex runs through the Codex CLI, which isn\'t on this host: neither the OpenAI extension ' +
          '(openai.chatgpt) nor `codex` on PATH was found. Install one, then add the provider again.',
        { modal: true },
        'Install with npm',
        'Show the OpenAI extension'
      );
      if (pick === 'Install with npm') {
        const t = vscode.window.createTerminal('Install Codex');
        t.show();
        t.sendText('npm install -g @openai/codex');
      } else if (pick === 'Show the OpenAI extension') {
        void vscode.commands.executeCommand('workbench.extensions.search', 'openai.chatgpt');
      }
      return;
    }
    const auth = (
      await vscode.window.showQuickPick(
        [
          {
            label: '$(account) ChatGPT plan',
            description: "Codex's own sign-in (codex login)",
            detail: "Counts toward your plan's Codex limits (5-hour and weekly) — shown in provider_usage",
            auth: 'chatgpt' as CodexAuth,
          },
          {
            label: '$(key) OpenAI API key',
            description: 'platform.openai.com/api-keys',
            detail: 'Billed per token to the key',
            auth: 'api-key' as CodexAuth,
          },
        ],
        { title: 'Add OpenAI Codex: how Codex signs in' }
      )
    )?.auth;
    if (!auth) return;
    // A ChatGPT plan is whichever account Codex is signed in as. Its default here is a sign-in of this
    // provider's own: this host has ONE Codex sign-in (~/.codex), shared by every Claude account on it,
    // and a work account's provider must not quietly ride on a personal one (or the reverse).
    let home: 'own' | 'shared' | undefined;
    let orphan: { id: string; dir: string } | undefined;
    if (auth === 'chatgpt') {
      const host = await this.sharedCodexInfo();
      home = (
        await vscode.window.showQuickPick(
          [
            {
              label: '$(shield) Its own sign-in (recommended)',
              description: 'a separate ChatGPT sign-in, for this provider alone',
              detail: "Nothing is shared with other Claude accounts on this host. You'll sign in to the ChatGPT account you want to use here.",
              home: 'own' as const,
            },
            {
              label: "$(account) This host's Codex sign-in",
              description: host.who ? `signed in as ${host.who}` : 'not signed in on this host',
              detail:
                `The sign-in in ~/.codex, shared with every Claude account on this host` +
                `${host.users.length ? ` (also used by ${host.users.join(', ')})` : ''}. Choose it only if that ChatGPT account is the one you mean to use here.`,
              home: 'shared' as const,
            },
          ],
          { title: 'Add OpenAI Codex: whose ChatGPT sign-in?' }
        )
      )?.home;
      if (!home) return;
      if (home === 'own') {
        // State can be lost while Codex's sign-ins survive. Check every Claude
        // account on this host so a provider that still exists is never offered.
        const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
        const referenced = new Set(Object.values(all).flatMap((list) => list.map((p) => p.id)));
        const orphans = findOrphanCodexHomes(workingRoot(), referenced);
        if (orphans.length) {
          const items = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Looking for existing Codex sign-ins…' },
            () => Promise.all(orphans.map(async (found) => {
              const account = await codexAccount({ bin, home: found.dir, env: {}, auth: 'chatgpt' }).catch(() => undefined);
              const who = account?.type === 'chatgpt' && account.email
                ? `${account.email}${account.plan ? ` (${account.plan})` : ''}`
                : 'signed-in account unknown';
              return {
                label: `$(account) ${who}`,
                description: 'a sign-in left on this host by a provider that no longer exists',
                detail: `Folder ${found.id}: this is the ChatGPT account it belongs to. Choose it only if it is the one you want for this Claude account.`,
                orphan: found,
              };
            }))
          );
          const pick = await vscode.window.showQuickPick(
            [...items, { label: '$(add) Sign in with a different ChatGPT account', description: '', detail: '', orphan: undefined }],
            { title: 'Add OpenAI Codex: reuse a sign-in found on this host?' }
          );
          if (!pick) return;
          orphan = pick.orphan;
        }
      }
    }
    const taken = (v: string) => this.list().some((p) => p.name === v.trim());
    const suggested = auth === 'chatgpt' ? 'Codex' : 'Codex (API key)';
    const name = await vscode.window.showInputBox({
      title: 'Add OpenAI Codex: name',
      prompt: "How workers on it are named (e.g. codex/gpt-6.1-sol) and shown in the account's hover",
      value: taken(suggested) ? '' : suggested,
      validateInput: (v) => (!v.trim() ? 'Enter a name' : taken(v) ? 'That name is taken' : undefined),
    });
    if (!name) return;
    let key: string | undefined;
    if (auth === 'api-key') {
      key = (
        await vscode.window.showInputBox({
          title: 'OpenAI API key',
          prompt: "From platform.openai.com/api-keys. Stored in VS Code's secret storage on this computer",
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (/^sk-\S{20,}$/.test(v.trim()) ? undefined : 'An OpenAI key starts with sk-'),
        })
      )?.trim();
      if (!key) return;
    }
    let provider: Provider = { id: crypto.randomBytes(6).toString('hex'), name: name.trim(), kind: 'codex', codexAuth: auth, ...(home && { codexHome: home }), baseUrl: '', auth: 'bearer' };
    if (!(await this.termsCheck(provider))) return;
    if (key) await this.context.secrets.store(this.secretKey(provider.id), key);
    await this.save([...this.list(), provider]);
    log(`provider added: ${provider.name} (OpenAI Codex, ${auth}, ${bin})`);
    if (orphan) {
      const target = keyCodexHome(workingRoot(), provider.id);
      try {
        fs.rmdirSync(target); // keyCodexHome made an empty directory; move the whole sign-in into its place.
        fs.renameSync(orphan.dir, target);
      } catch {
        // A move may fail across filesystems. Keep the original home intact.
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        const authFile = path.join(target, 'auth.json');
        fs.copyFileSync(path.join(orphan.dir, 'auth.json'), authFile);
        fs.chmodSync(authFile, 0o600);
      }
      log(`provider ${provider.name}: reusing the Codex sign-in found in ${orphan.id}`);
    }
    if (!(await this.checkCodex(provider))) return;
    provider = await this.refreshCodexModels(provider);
    const updated = await this.pickWorkers(provider);
    if (!updated) {
      vscode.window.showInformationMessage(`Added ${provider.name}. Pick its workers any time under "Edit or Remove a Provider".`);
      return;
    }
    await this.save(this.list().map((p) => (p.id === updated.id ? updated : p)));
    this.onDidChange.fire();
    const done = updated.workers?.length
      ? `${updated.name}: workers ${updated.workers.join(', ')}. New Claude Code sessions get them.`
      : `Added ${updated.name}, with no workers yet.`;
    if (auth !== 'api-key' || !this.settingsFile()) {
      vscode.window.showInformationMessage(done);
      return;
    }
    // An API key can also serve chat windows, through the local proxy.
    const pick = await vscode.window.showInformationMessage(`${done} It can also run Claude Code chat windows on GPT.`, 'Set up chat windows');
    if (pick) await this.useInWindow(updated);
  }

  /** Who this host's own Codex (~/.codex) is signed in as, and which providers — in any Claude account — use it. */
  private async sharedCodexInfo(): Promise<{ who?: string; users: string[] }> {
    const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
    const users = Object.entries(all).flatMap(([email, list]) => list.filter(sharesUserCodex).map((x) => `"${x.name}" (${email})`));
    const bin = await codexBinary();
    const a = bin ? await codexAccount({ bin, home: userCodexHome(), env: {}, auth: 'chatgpt' }) : undefined;
    return { who: a?.type === 'chatgpt' ? `${a.email ?? 'a ChatGPT account'}${a.plan ? ` (${a.plan})` : ''}` : undefined, users };
  }

  /** Switches a Codex ChatGPT provider between its own sign-in and this host's, then checks it (a sign-in prompt when signed out). */
  private async setCodexHome(p: Provider, mode: 'own' | 'shared'): Promise<void> {
    const updated: Provider = { ...p, codexHome: mode };
    await this.save(this.list().map((x) => (x.id === p.id ? updated : x)));
    const ack = this.state.get<Record<string, boolean>>('claudeProfiles.codexSharedAck', {});
    if (mode === 'shared') ack[p.id] = true;
    else delete ack[p.id];
    await this.state.update('claudeProfiles.codexSharedAck', ack);
    // Leaving a sign-in of its own behind would leave a token nobody uses.
    if (mode === 'shared') fs.rmSync(path.join(workingRoot(), 'codex', p.id), { recursive: true, force: true });
    log(`provider ${p.name}: Codex sign-in is now ${mode === 'own' ? 'its own' : "this host's (~/.codex)"}`);
    this.onDidChange.fire();
    await this.checkCodex(updated);
  }

  /**
   * Providers made before 1.17.1 all ride on this host's one Codex sign-in. When
   * Claude accounts of more than one email do — a work account's and a personal
   * one's on the same Linux user — say so, and offer each its own. Never changes
   * anything by itself. Asked again next start unless the user keeps sharing.
   */
  async noticeSharedCodex(): Promise<void> {
    const all = this.state.get<Record<string, Provider[]>>('claudeProfiles.providers', {});
    const shared = Object.entries(all).flatMap(([email, list]) => list.filter(sharesUserCodex).map((p) => ({ p, email })));
    if (new Set(shared.map((s) => s.email)).size < 2) return;
    const ack = this.state.get<Record<string, boolean>>('claudeProfiles.codexSharedAck', {});
    for (const p of this.list().filter((x) => sharesUserCodex(x) && !ack[x.id])) {
      const others = shared.filter((s) => s.email !== this.email()).map((s) => `"${s.p.name}" (${s.email})`);
      const pick = await vscode.window.showWarningMessage(
        `${p.name} uses this host's one Codex sign-in, which ${others.join(', ')} — under another Claude account — uses too. ` +
          `That's whichever ChatGPT account Codex is signed in as, for every Claude account on this host. If these are meant to be ` +
          `different accounts (a work one and a personal one), give ${p.name} its own sign-in.`,
        'Give it its own sign-in',
        'Keep sharing'
      );
      if (pick === 'Give it its own sign-in') await this.setCodexHome(p, 'own');
      else if (pick === 'Keep sharing') {
        ack[p.id] = true;
        await this.state.update('claudeProfiles.codexSharedAck', ack);
      }
    }
  }

  /**
   * Tests a Codex provider and, for a ChatGPT plan that isn't signed in, offers
   * Codex's own sign-in in a terminal (a device code in a remote window, where
   * the browser runs elsewhere). True once it works.
   */
  private async checkCodex(p: Provider): Promise<boolean> {
    for (;;) {
      const ctx = await this.codexContext(p.id);
      if (!ctx) {
        vscode.window.showWarningMessage(`${p.name}: Codex isn't available — no \`codex\` on this host, or no stored API key.`);
        return false;
      }
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking ${p.name}…` },
        () => testCodex(ctx, ctx.env.CODEX_API_KEY)
      );
      if (r.ok) {
        log(`provider ${p.name}: Codex OK — ${r.detail}`);
        vscode.window.showInformationMessage(`${p.name}: ${r.detail}.`);
        return true;
      }
      log(`provider ${p.name}: Codex check failed — ${r.message}`);
      const actions = p.codexAuth === 'api-key' ? ['Replace key'] : ['Sign in to Codex', 'Check again'];
      const pick = await vscode.window.showWarningMessage(`${p.name}: ${r.message}\n\n${r.hint}`, { modal: true }, ...actions);
      if (pick === 'Sign in to Codex') {
        const t = vscode.window.createTerminal({ name: 'Codex sign-in', env: { CODEX_HOME: ctx.home } });
        t.show();
        t.sendText(`"${ctx.bin}" login${vscode.env.remoteName ? ' --device-auth' : ''}`);
        const next = await vscode.window.showInformationMessage(
          `Finish signing in to Codex in the terminal${vscode.env.remoteName ? ' (open the link it shows and enter the code)' : ''}, then check again.`,
          'Check again'
        );
        if (next !== 'Check again') return false;
      } else if (pick === 'Replace key') {
        const key = (
          await vscode.window.showInputBox({ title: `OpenAI API key for ${p.name}`, password: true, ignoreFocusOut: true, validateInput: (v) => (/^sk-\S{20,}$/.test(v.trim()) ? undefined : 'An OpenAI key starts with sk-') })
        )?.trim();
        if (!key) return false;
        await this.context.secrets.store(this.secretKey(p.id), key);
      } else if (pick !== 'Check again') {
        return false;
      }
    }
  }

  /** Reads the models Codex offers this account (its own catalog) into the provider. */
  private async refreshCodexModels(p: Provider): Promise<Provider> {
    const ctx = await this.codexContext(p.id);
    if (!ctx) return p;
    const [models, caps] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Reading ${p.name}'s models…` },
      () => Promise.all([codexModels(ctx), codexCapabilities(ctx)])
    );
    const updated: Provider = { ...p, codexModels: models, ...(caps && { codexImages: caps.imageGeneration }) };
    await this.save(this.list().map((x) => (x.id === p.id ? updated : x)));
    log(`provider ${p.name}: Codex models ${models.map((m) => m.id).join(', ')}`);
    return updated;
  }

  private static validateAnthropicKey(v: string): string | undefined {
    return /^sk-ant-\S+$/.test(v.trim()) ? undefined : 'An Anthropic API key starts with sk-ant-';
  }

  /** An Anthropic API key: no URL, no header choice, no model list — Claude Code knows Anthropic. */
  private async addAnthropicKey(): Promise<void> {
    const taken = (v: string) => this.list().some((p) => p.name === v.trim());
    const name = await vscode.window.showInputBox({
      title: 'Add an Anthropic API key (1/2): name',
      prompt: 'Shown in the status bar',
      value: taken('Anthropic API') ? '' : 'Anthropic API',
      validateInput: (v) => (!v.trim() ? 'Enter a name' : taken(v) ? 'That name is taken' : undefined),
    });
    if (!name) return;
    const key = await vscode.window.showInputBox({
      title: 'Add an Anthropic API key (2/2): key',
      prompt: 'From console.anthropic.com → API keys. Stored in VS Code\'s secret storage on this computer',
      password: true,
      ignoreFocusOut: true,
      validateInput: ProviderManager.validateAnthropicKey,
    });
    if (!key) return;
    const provider: Provider = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim(),
      kind: 'anthropic',
      baseUrl: ANTHROPIC_API,
      auth: 'x-api-key',
    };
    if (!(await this.termsCheck(provider))) return;
    await this.context.secrets.store(this.secretKey(provider.id), key.trim());
    await this.save([...this.list(), provider]);
    log(`provider added: ${provider.name} (Anthropic API key)`);
    await this.offerNewProvider(
      provider,
      key.trim(),
      "windows using it bill your Anthropic API key per token; the account's login stays saved."
    );
  }

  private async pickAuth(current?: Provider['auth']): Promise<Provider['auth'] | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'Authorization: Bearer',
          description: current === 'bearer' ? 'current' : 'recommended — Poe uses this',
          detail: 'Sets ANTHROPIC_AUTH_TOKEN',
          value: 'bearer' as const,
        },
        {
          label: 'x-api-key',
          description: current === 'x-api-key' ? 'current' : '',
          detail: 'Sets ANTHROPIC_API_KEY',
          value: 'x-api-key' as const,
        },
      ],
      { title: 'How does the gateway take its key?' }
    );
    return picked?.value;
  }

  /**
   * Per-family default model, picked from the gateway's list. "Newest" keeps
   * following the list as the gateway adds models; a specific pick stays put.
   */
  private async pickDefaultModels(p: Provider): Promise<Provider['models'] | undefined> {
    const models = { ...(p.models ?? {}) };
    for (;;) {
      const family = (
        await vscode.window.showQuickPick(
          FAMILIES.filter((f) => p.catalog!.some((m) => m.family === f)).map((f) => ({
            label: f,
            description: models[f] ? models[f] : `newest — ${newest(p.catalog!, f)?.gatewayId}`,
            family: f,
          })),
          { title: `${p.name}: default model per family`, placeHolder: 'Pick a family to change; Esc when done' }
        )
      )?.family;
      if (!family) return models;
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Newest', description: 'follows the gateway as it adds models', id: undefined as string | undefined },
          ...p.catalog!
            .filter((m) => m.family === family)
            .map((m) => ({
              label: m.gatewayId,
              description: m.contextLength ? `${Math.round(m.contextLength / 1000)}K context` : '',
              id: m.gatewayId as string | undefined,
            })),
        ],
        { title: `${p.name}: ${family} model` }
      );
      if (!choice) continue;
      if (choice.id) models[family] = choice.id;
      else delete models[family];
    }
  }

  /**
   * GPT models for chat windows on an OpenAI API key: which appear in Claude
   * Code's model picker, and which one it uses by default. Through the local
   * LiteLLM proxy, billed to the key. Undefined when cancelled.
   */
  private async pickChatModels(target: Provider): Promise<Provider | undefined> {
    const choices = target.codexModels?.length ? target.codexModels : CODEX_FALLBACK_MODELS;
    const on = new Set(target.extraModels ?? []);
    const picked = await vscode.window.showQuickPick(
      choices.map((m) => ({ label: m.id, description: `${m.name} — ${m.note}`, picked: on.has(m.id) })),
      {
        title: `${target.name}: GPT models for chat windows`,
        placeHolder: "Each appears in Claude Code's model picker. None selected = no chat windows on this provider.",
        canPickMany: true,
      }
    );
    if (!picked) return undefined;
    const models = picked.map((i) => i.label);
    const updated: Provider = { ...target, extraModels: models.length ? models : undefined };
    if (models.length === 0) {
      updated.models = undefined;
      await stopProxy(target.id);
      return updated;
    }
    if (on.size === 0) {
      const ok = await vscode.window.showWarningMessage(
        `Use GPT in Claude Code chat windows on ${target.name}?\n\n` +
          `• A local LiteLLM proxy (installed on first use, hash-pinned, 127.0.0.1 only) translates Claude Code's ` +
          `requests for OpenAI. Your API key stays in the proxy's memory.\n` +
          `• Billed per token to this API key — not your ChatGPT plan.\n` +
          `• Claude Code is built for Claude: GPT uses its tools, but less reliably.`,
        { modal: true },
        'Use GPT in chats'
      );
      if (ok !== 'Use GPT in chats') return undefined;
    }
    const current = codexSlots({ ...updated, models: target.models }).sonnet;
    const main =
      models.length === 1
        ? models[0]
        : (
            await vscode.window.showQuickPick(
              models.map((m) => ({ label: m, description: m === current ? 'current default' : undefined })),
              { title: `${target.name}: default model for chats`, placeHolder: "Claude Code's default (its sonnet slot); opus and haiku get the closest enabled match" }
            )
          )?.label ?? current;
    updated.models = codexSlots({ ...updated, models: { sonnet: main } });
    updated.models.sonnet = main;
    return updated;
  }

  /**
   * Which of a provider's models the window's AI may consult, and which of those
   * may also run agent tasks — each new one confirmed, saying what it means for
   * this kind of provider. Undefined when cancelled.
   */
  private async pickWorkers(target: Provider): Promise<Provider | undefined> {
    const updated: Provider = { ...target };
    const codex = isCodex(target);
    const google = isGoogle(target);
    const choices = workerChoices(target);
    if (choices.length === 0) {
      vscode.window.showInformationMessage(`${target.name} has no models to offer as workers yet — set its model aliases first.`);
      return undefined;
    }
    const on = new Set(target.workers ?? []);
    const picked = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.model, description: c.note, picked: on.has(c.model) })),
      {
        title: `${target.name}: models this window's AI may consult as workers`,
        placeHolder: 'Workers only answer — they cannot read files or run commands. None selected = off.',
        canPickMany: true,
      }
    );
    if (!picked) return undefined;
    const models = picked.map((i) => i.label);
    const adding = models.filter((m) => !on.has(m));
    if (adding.length > 0) {
      const billing = google ? "Google AI, counted toward your Google AI plan's limits" : codex
        ? target.codexAuth === 'api-key'
          ? 'OpenAI, billed to this API key'
          : "OpenAI, counted toward your ChatGPT plan's Codex limits"
        : `${target.name}${isNative(target) ? '' : " and the model's maker"}, billed to this key`;
      const ok = await vscode.window.showWarningMessage(
        `Let Claude Code in this account's windows send work to ${target.name} (${adding.join(', ')})?\n\n` +
          `• The AI decides what to send: the task and the code or text it pastes in — that content goes to ${billing}.\n` +
          (google
            ? '• Each call runs agy itself in an empty folder, with shell and URL actions refused. Only Antigravity uses the plan; CPPO never reads its sign-in.\n'
            : codex
            ? '• Each call runs Codex itself, headless, read-only in an empty folder, with its shell and other tools off: it only answers.\n'
            : '• Workers only answer. They cannot read your files or run commands.\n') +
          `• Off again any time here; the window log records each call (not its content).`,
        { modal: true },
        'Allow'
      );
      if (ok !== 'Allow') return undefined;
    }
    updated.workers = models.length > 0 ? models : undefined;
    // Agent tasks: a separate, stronger opt-in among the enabled workers.
    const agentOn = new Set((target.agentWorkers ?? []).filter((m) => models.includes(m)));
    if (models.length === 0) {
      updated.agentWorkers = undefined;
      return updated;
    }
    const agentPick = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m, picked: agentOn.has(m) })),
      {
        title: `${target.name}: which of these may also run AGENT TASKS?`,
        placeHolder: google
          ? 'Agent tasks run agy in a scratch git worktree: edit-only, no shell, no builds or tests. None = answers only.'
          : codex
          ? 'Agent tasks run Codex on this model in a scratch git worktree, with edits and commands (its sandbox, approvals reviewed automatically). None = answers only.'
          : 'Agent tasks run Claude Code on this model in a scratch git worktree, with edits and commands (auto mode). None = answers only.',
        canPickMany: true,
      }
    );
    const agents = (agentPick ?? []).map((i) => i.label);
    const newAgents = agents.filter((m) => !agentOn.has(m));
    if (newAgents.length > 0) {
      const ok = await vscode.window.showWarningMessage(
        `Let ${target.name} (${newAgents.join(', ')}) run agent tasks?\n\n` +
          (google
            ? `• agy runs on that model in a scratch git worktree (HEAD + uncommitted changes), reading and editing files only. Shell commands and URL actions are refused. The lead must run builds and tests. Only Antigravity uses the plan; CPPO never reads its sign-in.\n`
            : codex
            ? `• Codex runs on that model, headless, in a git worktree made from your repo (HEAD + uncommitted ` +
              `changes). It reads and edits files there and runs commands in its sandbox: writes only inside the ` +
              `worktree, no network for commands. Its approval requests are reviewed automatically (--approve-for-me).\n`
            : `• Claude Code runs on that model, headless, in a git worktree made from your repo (HEAD + ` +
              `uncommitted changes). It reads and edits files there and runs commands — on this machine.\n` +
              `• Auto mode checks each consequential action with a safety classifier on that same model ` +
              `(about 35K tokens per check).\n`) +
          `• Nothing reaches your working tree unless the lead applies the diff. The repo content it reads goes to ` +
          `${codex ? 'OpenAI' : target.name}. Limits: 2 at a time, 2 hours each by default.`,
        { modal: true },
        'Allow agent tasks'
      );
      if (ok !== 'Allow agent tasks') agents.splice(0, agents.length, ...[...agentOn]);
    }
    updated.agentWorkers = agentPick === undefined ? [...agentOn] : agents.length > 0 ? agents : undefined;
    return updated;
  }

  async editInteractive(): Promise<void> {
    const providers = this.list();
    const LOGIN = '__login__';
    const chosen = await vscode.window.showQuickPick(
      [
        {
          label: '$(account) Anthropic login (this account)',
          description: this.loginWorkers().length ? `workers: ${this.loginWorkers().join(', ')}` : 'workers: off',
          provider: undefined as Provider | undefined,
          id: LOGIN,
        },
        ...providers.map((p) => ({
          label: p.name,
          description: describeKind(p),
          provider: p as Provider | undefined,
          id: p.id,
        })),
      ],
      { title: 'Edit or remove a provider' }
    );
    if (!chosen) return;
    if (chosen.id === LOGIN) return this.editLoginWorkers();
    const target = chosen.provider;
    if (!target) return;

    type Action = 'test' | 'workers' | 'key' | 'url' | 'auth' | 'models' | 'others' | 'refresh' | 'proxylog' | 'betas' | 'rename' | 'remove' | 'signin' | 'codexmodels' | 'chatmodels' | 'codexhome' | 'googlehome' | 'googlemodels';
    type ActionItem = vscode.QuickPickItem & { action: Action };
    const common = (items: ActionItem[]): ActionItem[] => [
      { label: '$(pulse) Test connection', description: 'one tiny request, as Claude Code sends it', action: 'test' },
      {
        label: '$(organization) Workers',
        description: target.workers?.length
          ? target.workers.map((m) => (target.agentWorkers?.includes(m) ? `${m} (+agent)` : m)).join(', ')
          : 'off',
        detail: "Let this window's AI consult this provider's models for focused tasks (answers only)",
        action: 'workers',
      },
      { label: '$(key) Replace key', action: 'key' },
      ...items,
      { label: '$(edit) Rename', action: 'rename' },
      { label: '$(trash) Remove', action: 'remove' },
    ];
    const action = (
      await vscode.window.showQuickPick<ActionItem>(
        isGoogle(target)
          ? [
              { label: '$(pulse) Test connection', description: 'sign-in and models only — no prompt', action: 'test' },
              { label: '$(organization) Workers', description: target.workers?.join(', ') || 'off', action: 'workers' },
              { label: '$(refresh) Refresh models', description: `${target.googleModels?.length ?? 0} families`, action: 'googlemodels' },
              { label: '$(account) Sign in to Google AI', description: sharesUserGoogle(target) ? "this host's shared sign-in" : 'its own sign-in', action: 'signin' },
              { label: sharesUserGoogle(target) ? '$(shield) Give it its own sign-in' : "$(account) Use this host's Google AI sign-in instead", action: 'googlehome' },
              { label: '$(edit) Rename', action: 'rename' },
              { label: '$(trash) Remove', action: 'remove' },
            ]
          : isCodex(target)
          ? [
              { label: '$(pulse) Test connection', description: target.codexAuth === 'api-key' ? 'checks the API key' : 'who Codex is signed in as', action: 'test' },
              {
                label: '$(organization) Workers',
                description: target.workers?.length
                  ? target.workers.map((m) => (target.agentWorkers?.includes(m) ? `${m} (+agent)` : m)).join(', ')
                  : 'off',
                detail: "Let this window's AI consult Codex, or have it run agent tasks",
                action: 'workers',
              },
              {
                label: '$(refresh) Refresh model list',
                description: `${(target.codexModels ?? CODEX_FALLBACK_MODELS).length} models`,
                action: 'codexmodels',
              },
              ...(target.codexAuth === 'api-key'
                ? [
                    {
                      label: '$(comment-discussion) Chat-window models',
                      description: target.extraModels?.length ? `${target.extraModels.length} enabled — ${describeModels({ ...target, models: codexSlots(target) })}` : 'off',
                      detail: 'GPT in Claude Code chat windows, through the local LiteLLM proxy — billed to the key',
                      action: 'chatmodels' as Action,
                    },
                    ...(target.extraModels?.length ? [{ label: '$(output) Show proxy log', action: 'proxylog' as Action }] : []),
                    { label: '$(key) Replace key', action: 'key' as Action },
                  ]
                : [
                    { label: '$(account) Sign in to Codex', description: sharesUserCodex(target) ? "this host's sign-in (~/.codex)" : 'its own sign-in', action: 'signin' as Action },
                    sharesUserCodex(target)
                      ? { label: '$(shield) Give it its own sign-in', description: 'stop using the sign-in shared with other Claude accounts', action: 'codexhome' as Action }
                      : { label: "$(account) Use this host's Codex sign-in instead", description: '~/.codex, shared with every Claude account here', action: 'codexhome' as Action },
                  ]),
              { label: '$(edit) Rename', action: 'rename' },
              { label: '$(trash) Remove', action: 'remove' },
            ]
          : isNative(target)
          ? common([])
          : common([
          // A preset's endpoint and key header are what the preset is; only a custom gateway changes them.
          ...(target.preset
            ? []
            : [
                { label: '$(link) Change base URL', description: target.baseUrl, action: 'url' as Action },
                {
                  label: '$(shield) Key header',
                  description: target.auth === 'bearer' ? 'Bearer' : 'x-api-key',
                  action: 'auth' as Action,
                },
              ]),
          {
            label: target.catalog?.length ? '$(symbol-enum) Default models' : '$(symbol-enum) Model aliases',
            description: describeModels(target) || 'Claude Code defaults',
            action: 'models',
          },
          // Non-Claude models through the proxy, and the model list itself, only
          // where the models come from the gateway's list (not Z.ai's fixed GLM).
          ...(readsCatalog(target)
            ? [
                {
                  label: '$(extensions) Non-Claude models',
                  description: target.extraModels?.length
                    ? `${target.extraModels.length} enabled, through the local proxy`
                    : `${target.otherCatalog?.length ?? 0} available`,
                  detail: 'Qwen, GLM, DeepSeek… translated for Claude Code by a local LiteLLM proxy',
                  action: 'others' as Action,
                },
                ...(target.extraModels?.length
                  ? [{ label: '$(output) Show proxy log', action: 'proxylog' as Action }]
                  : []),
                {
                  label: '$(refresh) Refresh model list',
                  description: target.catalogAt
                    ? `${target.catalog?.length ?? 0} Claude models, read ${new Date(target.catalogAt).toLocaleString()}`
                    : 'not read yet',
                  action: 'refresh' as Action,
                },
              ]
            : []),
          {
            label: `$(beaker) ${target.disableBetas ? 'Send' : 'Stop sending'} experimental beta headers`,
            description: target.disableBetas ? 'currently off' : 'currently on',
            detail: 'Turn off if the gateway answers "Unexpected value(s)" or "Extra inputs are not permitted"',
            action: 'betas',
          },
        ]),
        { title: target.name }
      )
    )?.action;
    if (!action) return;

    const updated: Provider = { ...target };
    switch (action) {
      case 'workers': {
        const picked = await this.pickWorkers(target);
        if (!picked) return;
        Object.assign(updated, { workers: picked.workers, agentWorkers: picked.agentWorkers });
        break;
      }
      case 'signin':
        if (isGoogle(target)) { await this.signInGoogle(target); return; }
        await this.checkCodex(target);
        return;
      case 'googlemodels':
        await this.ensureGoogleFacts();
        this.onDidChange.fire();
        return;
      case 'googlehome': {
        const mode = sharesUserGoogle(target) ? 'own' : 'shared';
        const users = this.sharedGoogleUsers();
        const ok = await vscode.window.showWarningMessage(
          mode === 'own'
            ? `Give ${target.name} its own Google AI sign-in? It will ask you to sign in separately, for example to keep work and personal accounts apart.`
            : `Use this host's Google AI sign-in for ${target.name}? There is one sign-in per Linux user, whatever Claude account is active${users.length ? ` (also used by ${users.join(', ')})` : ''}. Its own sign-in is removed.`,
          { modal: true }, 'Change sign-in'
        );
        if (ok === 'Change sign-in') await this.setGoogleHome(target, mode);
        return;
      }
      case 'codexhome': {
        if (sharesUserCodex(target)) {
          const ok = await vscode.window.showWarningMessage(
            `Give ${target.name} its own Codex sign-in?\n\nIt will stop using this host's Codex sign-in (~/.codex) and ask you to sign in ` +
              `to the ChatGPT account you want for it. Other providers on the host's sign-in are unaffected.`,
            { modal: true },
            'Give it its own sign-in'
          );
          if (ok === 'Give it its own sign-in') await this.setCodexHome(target, 'own');
          return;
        }
        const host = await this.sharedCodexInfo();
        const ok = await vscode.window.showWarningMessage(
          `Use this host's Codex sign-in for ${target.name}?\n\n` +
            `${host.who ? `Codex here is signed in as ${host.who}.` : 'Codex on this host is not signed in.'} It's shared with every Claude account ` +
            `on this host${host.users.length ? ` (also used by ${host.users.join(', ')})` : ''}. ${target.name}'s own sign-in is removed.`,
          { modal: true },
          "Use this host's sign-in"
        );
        if (ok === "Use this host's sign-in") await this.setCodexHome(target, 'shared');
        return;
      }
      case 'chatmodels': {
        const picked = await this.pickChatModels(target);
        if (!picked) return;
        Object.assign(updated, { extraModels: picked.extraModels, models: picked.models });
        break;
      }
      case 'codexmodels':
        await this.refreshCodexModels(target);
        vscode.window.showInformationMessage(`${target.name}: model list refreshed.`);
        return;
      case 'test': {
        if (isGoogle(target)) { await this.checkGoogle(target); return; }
        if (isCodex(target)) {
          await this.checkCodex(target);
          return;
        }
        const key = await this.context.secrets.get(this.secretKey(target.id));
        if (!key) throw new Error(`No key is stored for ${target.name}. Replace its key first.`);
        const r = await this.testInteractive(target, key);
        if (r.ok) vscode.window.showInformationMessage(`${target.name} answered with ${r.model} in ${r.ms} ms.`);
        return;
      }
      case 'key': {
        const key = await vscode.window.showInputBox({
          title: `New key for ${target.name}`,
          password: true,
          ignoreFocusOut: true,
          validateInput: isNative(target)
            ? ProviderManager.validateAnthropicKey
            : isCodex(target)
              ? (v) => (/^sk-\S{20,}$/.test(v.trim()) ? undefined : 'An OpenAI key starts with sk-')
              : (v) => (v.trim() ? undefined : 'Enter the key'),
        });
        if (!key) return;
        await this.context.secrets.store(this.secretKey(target.id), key.trim());
        break;
      }
      case 'url': {
        const url = await vscode.window.showInputBox({
          title: `Base URL for ${target.name}`,
          value: target.baseUrl,
          validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
        });
        if (!url) return;
        updated.baseUrl = url.trim().replace(/\/+$/, '');
        break;
      }
      case 'auth': {
        const auth = await this.pickAuth(target.auth);
        if (!auth) return;
        updated.auth = auth;
        break;
      }
      case 'models': {
        if (target.catalog?.length) {
          const models = await this.pickDefaultModels(target);
          if (!models) return;
          updated.models = Object.keys(models).length > 0 ? models : undefined;
          break;
        }
        // No list from the gateway: name the models by hand.
        const input = await vscode.window.showInputBox({
          title: `Model aliases for ${target.name}`,
          prompt:
            'alias=model pairs as the gateway names them, comma-separated; empty for Claude Code\'s ' +
            'defaults. Claude models are mapped so Claude Code still recognises them.',
          placeHolder: 'opus=claude-opus-4-8, sonnet=claude-sonnet-4-6, haiku=claude-haiku-4-5',
          value: formatModels(target.models),
          validateInput: (v) => {
            const r = parseModels(v);
            return typeof r === 'string' ? r : undefined;
          },
        });
        if (input === undefined) return;
        const models = parseModels(input) as Provider['models'];
        updated.models = models && Object.keys(models).length > 0 ? models : undefined;
        break;
      }
      case 'others': {
        const others = target.otherCatalog ?? [];
        if (others.length === 0) {
          vscode.window.showInformationMessage(
            `${target.name}'s model list has no other models usable from Claude Code (text, tool calling, ` +
              `chat completions). Try "Refresh model list".`
          );
          return;
        }
        const enabled = new Set(target.extraModels ?? []);
        const picked = await vscode.window.showQuickPick(
          others.map((m) => ({
            label: m.id,
            description: [m.ownedBy, m.contextLength ? `${Math.round(m.contextLength / 1000)}K context` : 'context unknown']
              .filter(Boolean)
              .join(' · '),
            picked: enabled.has(m.id),
          })),
          {
            title: `${target.name}: non-Claude models for Claude Code`,
            placeHolder:
              'Each appears in Claude Code\'s model picker. Claude Code is built for Claude — tool use on ' +
              'other models works, but less reliably.',
            canPickMany: true,
            matchOnDescription: true,
          }
        );
        if (!picked) return;
        updated.extraModels = picked.length > 0 ? picked.map((i) => i.label) : undefined;
        if (!updated.extraModels) await stopProxy(target.id);
        break;
      }
      case 'proxylog': {
        if (!fs.existsSync(proxyLogFile(target.id))) {
          vscode.window.showInformationMessage(
            `${target.name}'s proxy hasn't run on this host yet — it starts when a window here switches to ` +
              `${target.name}.`
          );
          return;
        }
        const doc = await vscode.workspace.openTextDocument(proxyLogFile(target.id));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'refresh': {
        const key = await this.context.secrets.get(this.secretKey(target.id));
        if (!key) throw new Error(`No key is stored for ${target.name}. Replace its key first.`);
        const fresh = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Reading ${target.name}'s model list…` },
          () => this.refreshCatalog(target, key, true)
        );
        Object.assign(updated, { catalog: fresh.catalog, otherCatalog: fresh.otherCatalog, catalogAt: fresh.catalogAt });
        break;
      }
      case 'betas':
        updated.disableBetas = !target.disableBetas || undefined;
        break;
      case 'rename': {
        const name = await vscode.window.showInputBox({
          title: `Rename ${target.name}`,
          value: target.name,
          validateInput: (v) =>
            !v.trim()
              ? 'Enter a name'
              : this.list().some((p) => p.id !== target.id && p.name === v.trim())
                ? 'That name is taken'
                : undefined,
        });
        if (!name) return;
        updated.name = name.trim();
        break;
      }
      case 'remove': {
        const ok = await vscode.window.showWarningMessage(
          isGoogle(target)
            ? `Remove ${target.name}? ${sharesUserGoogle(target) ? "This host's shared Google AI sign-in stays in place." : 'Its private Google AI sign-in is removed.'}`
            : `Remove ${target.name}? Its key is deleted from secret storage, and every window using it goes ` +
              `back to its Anthropic login.`,
          { modal: true },
          'Remove'
        );
        if (ok !== 'Remove') return;
        await this.save(this.list().filter((p) => p.id !== target.id));
        await this.context.secrets.delete(this.secretKey(target.id));
        await stopProxy(target.id);
        if (isGoogle(target) && !sharesUserGoogle(target)) fs.rmSync(path.join(workingRoot(), 'agy', target.id), { recursive: true, force: true });
        if (isCodex(target) && !sharesUserCodex(target)) {
          fs.rmSync(path.join(workingRoot(), 'codex', target.id), { recursive: true, force: true }); // its own sign-in or key: nothing left behind
        }
        log(`provider removed: ${target.name}`);
        // This window used it: back to the Anthropic login now. Other windows find
        // it gone on their next sync (focus) and offer the reload themselves.
        if (this.context.workspaceState.get<string>(ACTIVE_KEY) === target.id) {
          await this.useInWindow(undefined);
        } else {
          vscode.window.showInformationMessage(`Removed ${target.name}.`);
        }
        return;
      }
    }
    await this.save(this.list().map((p) => (p.id === target.id ? updated : p)));
    log(`provider edited: ${updated.name} (${action})`);
    this.onDidChange.fire();
    // Turning other models on is the moment to install and start the proxy — the
    // background sync below never installs anything on its own.
    if ((action === 'others' || action === 'chatmodels') && updated.extraModels?.length) {
      const key = await this.context.secrets.get(this.secretKey(updated.id));
      if (key && !(await this.proxyFor(updated, key, true))) {
        vscode.window.showInformationMessage(
          `${updated.name}'s non-Claude models stay off until LiteLLM is installed — its Claude models keep working.`
        );
      }
    }
    if (this.active()?.id === target.id) await this.sync();
    else if (action === 'chatmodels' && updated.extraModels?.length && this.settingsFile()) {
      const pick = await vscode.window.showInformationMessage(
        `${updated.name}: chat windows can use ${updated.extraModels.join(', ')}.`,
        'Use in this window'
      );
      if (pick) await this.useInWindow(updated);
    } else vscode.window.showInformationMessage(`Updated ${updated.name}.`);
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}
