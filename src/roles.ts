import type { Worker } from './delegate';
import type { UsageEntry } from './usage';

/**
 * Roles: what a worker is for, decided by the user once instead of by the lead
 * on every call. The lead asks for a role — `delegate(role: "review")`,
 * `start_task(role: "implement")` — and the extension walks that role's chain:
 * the first entry that is enabled, can run, and whose plan isn't nearly used up
 * serves it; a call that fails for a reason the next entry may not share (rate
 * limit, used-up plan, sign-in) moves on to the next. Same inputs, same choice.
 *
 * Chains default to a template built from the workers that are configured
 * ("subscription first"); the orchestration panel edits them.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What a role needs from a worker. 'answer': any worker (delegate). 'agent': an
 * agent-task worker. 'image': an agent-task worker that can generate images
 * (Codex or Google AI, whose image generation saves files).
 */
export type RoleKind = 'answer' | 'agent' | 'image';

export interface RoleDef {
  id: string;
  category: string;
  label: string;
  kind: RoleKind;
  purpose: string;
  /** Default effort for its entries. */
  effort: Effort;
  /** How well a worker suits it, for the default chain (higher first; 0 = leave out). */
  score: (w: Worker) => number;
}

export interface RoleEntry {
  worker: string;
  effort?: Effort;
}

export interface Role {
  id: string;
  chain: RoleEntry[];
  /** Turned off by the user: the lead gets no such role. */
  off?: boolean;
}

export interface RolePolicy {
  roles: Role[];
  /** Skip an entry whose plan has used more than this of a 5-hour window (100 = never skip). */
  skip5hPct: number;
  /** …or of a weekly window. */
  skipWeeklyPct: number;
}

export const DEFAULT_SKIP_5H = 95;
export const DEFAULT_SKIP_WEEKLY = 90;

const m = (w: Worker, re: RegExp) => re.test(w.model);
/** Subscriptions first: the Anthropic login, Z.ai's Coding Plan, Codex on ChatGPT, Google AI. */
const subscription = (w: Worker) => Boolean(w.plan);
const fast = /haiku|flash|luna|mini|lite|nano/i;
// "mini" inside Gemini's name doesn't make Argon a quick model.
const isFast = (w: Worker) => fast.test(w.kind === 'google' ? w.model.replace(/^gemini-/i, '') : w.model);
const strongest = /opus|astra|ultra|gemini-4-argon/i;
const workhorse = /sonnet|sol|glm-5\.3(?!-flash)|terra/i;

export const CATALOG: RoleDef[] = [
  {
    id: 'quick',
    category: 'Answers',
    label: 'Quick',
    kind: 'answer',
    purpose: 'Summaries, bulk rewriting, quick checks — fast and cheap',
    effort: 'low',
    score: (w) => (isFast(w) ? 10 : m(w, workhorse) ? 4 : 1) + (subscription(w) ? 2 : 0),
  },
  {
    id: 'second-opinion',
    category: 'Answers',
    label: 'Second opinion',
    kind: 'answer',
    purpose: 'An independent take on a plan, a design or a bug — from another model family than the lead',
    effort: 'medium',
    // The lead is Claude: another family sees differently.
    score: (w) => (w.kind === 'login' ? 3 : 8) + (m(w, workhorse) ? 3 : m(w, strongest) ? 2 : 0) + (subscription(w) ? 2 : 0),
  },
  {
    id: 'review',
    category: 'Answers',
    label: 'Review',
    kind: 'answer',
    purpose: 'Code review of a diff or a file: bugs, risks, missing tests',
    effort: 'high',
    score: (w) => (m(w, workhorse) ? 8 : m(w, strongest) ? 7 : 2) + (w.kind === 'codex' ? 3 : 0) + (subscription(w) ? 2 : 0),
  },
  {
    id: 'hard-reasoning',
    category: 'Answers',
    label: 'Hard reasoning',
    kind: 'answer',
    purpose: 'The hardest questions: algorithms, architecture, subtle bugs',
    effort: 'max',
    score: (w) => (m(w, strongest) ? 10 : m(w, workhorse) ? 6 : 1) + (subscription(w) ? 2 : 0),
  },
  {
    id: 'implement',
    category: 'Build',
    label: 'Implement',
    kind: 'agent',
    purpose: 'Make a change in a scratch worktree, build and test it; the lead reviews the diff',
    effort: 'medium',
    score: (w) => (m(w, workhorse) ? 8 : m(w, strongest) ? 6 : 3) + (w.preset === 'zai' ? 3 : 0) + (subscription(w) ? 2 : 0),
  },
  {
    id: 'test-and-fix',
    category: 'Build',
    label: 'Test and fix',
    kind: 'agent',
    purpose: 'Run the tests, fix what fails, report what was wrong',
    effort: 'medium',
    score: (w) => (m(w, workhorse) ? 8 : isFast(w) ? 4 : 5) + (w.preset === 'zai' ? 3 : 0) + (subscription(w) ? 2 : 0),
  },
  {
    id: '2d-art',
    category: 'Art',
    label: '2D art',
    kind: 'image',
    purpose: 'Raster images — sprites, textures, concept art, icons — generated and saved as files in the worktree',
    effort: 'medium',
    // Codex's images rank ahead: Google's JPEGs cannot have real transparency.
    score: (w) => w.kind === 'google' ? (/gemini/i.test(w.model) ? 3 : 1) + (subscription(w) ? 2 : 0) : (m(w, workhorse) ? 6 : 4) + (subscription(w) ? 2 : 0),
  },
  {
    id: 'vector-art',
    category: 'Art',
    label: 'Vector art',
    kind: 'agent',
    purpose: 'SVG icons, diagrams and simple vector art, written as files in the worktree',
    effort: 'medium',
    score: (w) => (m(w, workhorse) ? 7 : m(w, strongest) ? 6 : 3) + (w.kind === 'codex' ? 2 : 0) + (subscription(w) ? 2 : 0),
  },
];

export const roleDef = (id: string) => CATALOG.find((r) => r.id === id);

/** Whether a worker can serve a role of this kind at all. */
export function fits(w: Worker, kind: RoleKind): boolean {
  if (kind === 'answer') return true;
  if (!w.agent) return false;
  return kind === 'agent' || ((w.kind === 'codex' || w.kind === 'google') && w.images !== false);
}

const MAX_CHAIN = 4;

/** A model's generation (gpt-6.1-sol → 6.1, glm-5.3 → 5.3, claude-opus-5-5 → 5.5): newer wins a tie. */
function generation(model: string): number {
  const m = /(\d+)(?:[.-](\d+))?/.exec(model.replace(/^[a-z]+-(?=\d)/i, ''));
  return m ? Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0) : 0;
}

/** At most this many entries of one provider in a template chain: its fallbacks are other providers. */
const PER_PROVIDER = 2;

/**
 * The template: each role's chain, best first — but one provider at a time, so
 * the first fallback is another provider (a used-up plan fails every model on
 * it), then a second model of each.
 */
export function defaultPolicy(workers: Worker[]): RolePolicy {
  return {
    roles: CATALOG.map((def) => {
      const ranked = workers
        .filter((w) => fits(w, def.kind) && !(def.id === 'test-and-fix' && w.noShell))
        .map((w) => ({ w, s: def.score(w) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || generation(b.w.model) - generation(a.w.model) || a.w.id.localeCompare(b.w.id));
      const chain: Worker[] = [];
      for (let round = 1; round <= PER_PROVIDER && chain.length < MAX_CHAIN; round++) {
        for (const { w } of ranked) {
          if (chain.length >= MAX_CHAIN) break;
          if (chain.includes(w)) continue;
          if (chain.filter((x) => x.providerId === w.providerId).length >= round) continue;
          chain.push(w);
        }
      }
      return { id: def.id, chain: chain.map((w) => ({ worker: w.id, effort: def.effort })) };
    }),
    skip5hPct: DEFAULT_SKIP_5H,
    skipWeeklyPct: DEFAULT_SKIP_WEEKLY,
  };
}

/**
 * The saved policy with the catalog's roles filled in and entries for workers
 * that no longer exist dropped. A role the user never edited follows the
 * template, so a newly enabled worker shows up in it.
 */
export function effectivePolicy(saved: RolePolicy | undefined, workers: Worker[]): RolePolicy {
  const template = defaultPolicy(workers);
  if (!saved) return template;
  const ids = new Set(workers.map((w) => w.id));
  return {
    skip5hPct: saved.skip5hPct ?? DEFAULT_SKIP_5H,
    skipWeeklyPct: saved.skipWeeklyPct ?? DEFAULT_SKIP_WEEKLY,
    roles: CATALOG.map((def) => {
      const mine = saved.roles.find((r) => r.id === def.id);
      if (!mine) return template.roles.find((r) => r.id === def.id)!;
      return { ...mine, chain: mine.chain.filter((e) => ids.has(e.worker)) };
    }),
  };
}

export interface Candidate {
  worker: Worker;
  effort?: Effort;
}

/** Why an entry was passed over, for the lead and the transcript. */
export interface Skip {
  worker: string;
  reason: string;
}

/**
 * The order in which a role's entries will be tried now. Entries that can't run
 * go; entries whose plan is past a threshold go to the back (thresholds are a
 * preference — when every plan is past them, the least-used still serves).
 */
export function candidates(
  policy: RolePolicy,
  roleId: string,
  workers: Worker[],
  usage: (provider: string) => UsageEntry | undefined,
  runnable: (w: Worker) => string | undefined
): { order: Candidate[]; skipped: Skip[] } | undefined {
  const def = roleDef(roleId);
  const role = policy.roles.find((r) => r.id === roleId);
  if (!def || !role || role.off) return undefined;
  const ok: Array<Candidate & { pressure: number }> = [];
  const later: Array<Candidate & { pressure: number }> = [];
  const skipped: Skip[] = [];
  for (const e of role.chain) {
    const w = workers.find((x) => x.id === e.worker);
    if (!w) continue;
    if (def.id === 'test-and-fix' && w.noShell) {
      skipped.push({ worker: e.worker, reason: "can't run commands (edit-only)" });
      continue;
    }
    if (!fits(w, def.kind)) {
      skipped.push({ worker: e.worker, reason: def.kind === 'image' ? 'not a Codex or Google AI agent-task worker (image generation)' : 'not enabled for agent tasks' });
      continue;
    }
    const why = runnable(w);
    if (why) {
      skipped.push({ worker: e.worker, reason: why });
      continue;
    }
    const u = usage(w.providerName);
    let over: string | undefined;
    let pressure = 0;
    for (const win of u?.windows ?? []) {
      if (win.scope && win.scope !== w.usageScope) continue;
      const weekly = /week/i.test(win.label);
      const limit = weekly ? policy.skipWeeklyPct : /5 hour|hour/i.test(win.label) ? policy.skip5hPct : 100;
      pressure = Math.max(pressure, win.usedPct / Math.max(limit, 1));
      if (win.usedPct >= limit && !over) over = `${w.providerName} ${win.label} at ${Math.round(win.usedPct)}% (threshold ${limit}%)`;
    }
    const c = { worker: w, effort: e.effort, pressure };
    if (over) {
      skipped.push({ worker: e.worker, reason: over });
      later.push(c);
    } else {
      ok.push(c);
    }
  }
  later.sort((a, b) => a.pressure - b.pressure);
  return { order: [...ok, ...later].map(({ worker, effort }) => ({ worker, effort })), skipped };
}

/**
 * Whether a failed call is worth retrying on the next entry: the next provider
 * may well not share a rate limit, an empty balance, a lost sign-in or an outage.
 * A malformed request would fail there too.
 */
export function worthFallingBack(message: string): boolean {
  return /\b(429|401|403|402|5\d\d)\b|rate.?limit|usage.?limit|quota|insufficient|balance|credit|1113|overloaded|unavailable|timed? ?out|timeout|ECONN|ETIMEDOUT|fetch failed|not signed in|sign in|unauthori[sz]ed|authentication|exceeded/i.test(
    message
  );
}

/** The level a runner accepts nearest to the one asked for (never above it). */
export function clampEffort(effort: Effort | undefined, supported: string[] | undefined): string | undefined {
  if (!effort) return undefined;
  if (!supported?.length) return effort;
  for (let i = EFFORTS.indexOf(effort); i >= 0; i--) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  return supported[0];
}

/** Effort as a thinking budget, for workers on the Messages API (Z.ai, gateways). */
export const THINKING_BUDGET: Record<Effort, number> = { low: 0, medium: 4_096, high: 12_288, xhigh: 20_480, max: 32_000 };
