import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { DelegateServer, Worker } from './delegate';
import type { ModelOffer, ProviderManager } from './providers';
import { candidates, CATALOG, defaultPolicy, EFFORTS, effectivePolicy, RolePolicy, roleDef } from './roles';
import { log } from './log';

/**
 * The orchestration panel: what's configured (accounts, providers, workers,
 * plan usage) and the roles — each one's fallback chain, effort and on/off —
 * with who would serve each right now. Edits preview live and save per account
 * and host (providers.saveRolePolicy); the workers server reads them on every
 * call (delegate.ts → roles.ts).
 */

interface Deps {
  providers: ProviderManager;
  workers: DelegateServer;
  account: () => { email?: string; login: string };
}

type FromPage =
  | { type: 'ready' }
  | { type: 'preview'; policy: RolePolicy }
  | { type: 'save'; policy: RolePolicy }
  | { type: 'reset' }
  | { type: 'refresh' }
  | { type: 'command'; id: string };

export class OrchestrationPanel {
  private static current: OrchestrationPanel | undefined;

  static show(deps: Deps): void {
    if (OrchestrationPanel.current) {
      OrchestrationPanel.current.panel.reveal();
      void OrchestrationPanel.current.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel('cppo.orchestration', 'Orchestration — CPPO', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    OrchestrationPanel.current = new OrchestrationPanel(panel, deps);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private factsRead = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: Deps
  ) {
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = html(nonce, panel.webview.cspSource);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: FromPage) => void this.onMessage(m)),
      deps.providers.onDidChange.event(() => void this.post()),
      panel.onDidDispose(() => this.dispose())
    );
  }

  private async onMessage(m: FromPage): Promise<void> {
    try {
      if (m.type === 'ready' || m.type === 'refresh') await this.post(m.type === 'refresh');
      else if (m.type === 'preview') await this.post(false, sanitize(m.policy));
      else if (m.type === 'save') {
        const policy = sanitize(m.policy);
        // Models the roles use that aren't enabled yet (as workers, or for agent tasks): one confirmation.
        const ids: string[] = [];
        const agentIds: string[] = [];
        for (const r of policy.roles) {
          if (r.off) continue;
          const kind = roleDef(r.id)?.kind ?? 'answer';
          for (const e of r.chain) {
            ids.push(e.worker);
            if (kind !== 'answer') agentIds.push(e.worker);
          }
        }
        if (!(await this.deps.providers.enableOffers(ids, agentIds))) {
          void this.panel.webview.postMessage({ type: 'notSaved' });
          return;
        }
        await this.deps.providers.saveRolePolicy(policy);
        log('orchestration: roles saved');
        vscode.window.setStatusBarMessage('$(check) Roles saved — new calls use them', 4000);
        await this.post();
      } else if (m.type === 'reset') {
        await this.deps.providers.saveRolePolicy(undefined);
        await this.post();
      } else if (m.type === 'command') {
        const allowed = ['cppo.addProvider', 'cppo.editProvider', 'cppo.showUsage', 'cppo.showWorkerTranscripts'];
        if (allowed.includes(m.id)) await vscode.commands.executeCommand(m.id);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Orchestration: ${(err as Error).message}`);
    }
  }

  /** Sends the page its state; with `draft`, the preview shows that policy instead of the saved one. */
  private async post(refreshUsage = false, draft?: RolePolicy): Promise<void> {
    if (!this.factsRead) {
      this.factsRead = true;
      await this.deps.providers.ensureGoogleFacts().catch((err) => log(`orchestration: Google AI facts — ${(err as Error).message}`));
      await this.deps.providers.ensureCodexFacts().catch((err) => log(`orchestration: Codex facts — ${(err as Error).message}`));
    }
    const enabled = this.deps.providers.workers();
    const offers = this.deps.providers.offers();
    // Every model as the worker it would be once enabled: what roles may use, and what the preview shows.
    const all = offers.map(asWorker);
    const book = this.deps.workers.usage;
    if (refreshUsage || !draft) await this.deps.workers.refreshUsage(refreshUsage);
    const unavailable = await this.deps.workers.unavailable(all);
    const saved = this.deps.providers.rolePolicy();
    // Unsaved, the roles are what calls get now: the template over the ENABLED workers.
    const policy = draft ?? (saved ? effectivePolicy(saved, all) : defaultPolicy(enabled));
    const served: Record<string, { order: string[]; skipped: string[] }> = {};
    for (const def of CATALOG) {
      const r = candidates(policy, def.id, all, (p) => book.get(p), (w) => unavailable.get(w.id));
      served[def.id] = {
        order: r?.order.map((c) => c.worker.id) ?? [],
        skipped: r?.skipped.map((s) => `${s.worker}: ${s.reason}`) ?? [],
      };
    }
    const providers = [...new Set(offers.map((o) => o.providerName))].map((name) => ({ name, usage: book.get(name), plan: offers.some((o) => o.providerName === name && o.kind === 'google') ? 'Google AI plan' : undefined }));
    void this.panel.webview.postMessage({
      type: 'state',
      account: this.deps.account(),
      providers,
      offers: offers.map((o) => ({ ...o, unavailable: unavailable.get(o.id) })),
      catalog: CATALOG.map(({ id, category, label, kind, purpose, effort }) => ({ id, category, label, kind, purpose, effort })),
      efforts: EFFORTS,
      policy,
      // "Suggest": the template over every model the providers offer — saving enables what it uses.
      template: defaultPolicy(all),
      custom: Boolean(saved),
      draft: Boolean(draft),
      served,
    });
  }

  dispose(): void {
    OrchestrationPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

/** A model as the worker it is, or would be once enabled (all its capabilities on). */
function asWorker(o: ModelOffer): Worker {
  return {
    id: o.id, providerId: o.providerId, providerName: o.providerName, model: o.model, baseUrl: '', auth: 'bearer', note: o.note,
    agent: o.can.agent, plan: o.plan, images: o.can.image, noShell: o.noShell, usageScope: o.usageScope,
    ...(o.kind && { kind: o.kind }), ...(o.preset && { preset: o.preset }),
  };
}

/** Only what a policy may hold: known roles, string worker ids, known efforts, thresholds 1–100. */
function sanitize(p: RolePolicy): RolePolicy {
  const ids = new Set(CATALOG.map((r) => r.id));
  const pct = (v: unknown, d: number) => (typeof v === 'number' && v >= 1 && v <= 100 ? Math.round(v) : d);
  return {
    skip5hPct: pct(p?.skip5hPct, 95),
    skipWeeklyPct: pct(p?.skipWeeklyPct, 90),
    roles: (Array.isArray(p?.roles) ? p.roles : [])
      .filter((r) => r && ids.has(r.id))
      .map((r) => ({
        id: r.id,
        ...(r.off && { off: true }),
        chain: (Array.isArray(r.chain) ? r.chain : [])
          .filter((e) => e && typeof e.worker === 'string')
          .slice(0, 8)
          .map((e) => ({ worker: e.worker, ...(EFFORTS.includes(e.effort as never) && { effort: e.effort }) })),
      })),
  };
}

function html(nonce: string, csp: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestration</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 20px 40px; max-width: 1100px; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 18px 0 4px; }
  h2 { font-size: 1.1em; font-weight: 600; margin: 26px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px 12px; background: var(--vscode-sideBar-background, transparent); }
  .role { margin-bottom: 12px; }
  .role.off { opacity: 0.55; }
  .badge { font-size: 0.8em; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .bar { height: 6px; background: var(--vscode-progressBar-background); border-radius: 3px; }
  .track { height: 6px; background: var(--vscode-input-background); border-radius: 3px; width: 140px; overflow: hidden; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .err { color: var(--vscode-errorForeground); }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 3px 4px; vertical-align: middle; }
  select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 4px; font: inherit; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; font: inherit; border-radius: 2px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.icon { background: transparent; color: var(--vscode-foreground); padding: 2px 6px; }
  button:disabled { opacity: 0.4; cursor: default; }
  .served { margin-top: 6px; font-size: 0.92em; }
  .sticky { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 10px 0; z-index: 1; border-bottom: 1px solid var(--vscode-panel-border); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style></head>
<body>
<h1>Orchestration</h1>
<div class="muted">Which models serve which kind of work, at what effort, and what takes over when one runs out. The lead asks by role; the extension picks.</div>
<div class="sticky row" id="actions"></div>
<h2>What's configured</h2>
<div id="inventory"></div>
<h2>Thresholds</h2>
<div id="thresholds"></div>
<div id="roles"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let S = null, P = null, dirty = false, timer = null;
const $ = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c))); return e; };
const clone = (x) => JSON.parse(JSON.stringify(x));
function changed() { dirty = true; renderActions(); clearTimeout(timer); timer = setTimeout(() => vscode.postMessage({ type: 'preview', policy: P }), 250); renderRoles(); }
function until(ms) { const m = Math.max(0, Math.round((ms - Date.now()) / 60000)); return m < 90 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; }
function renderActions() {
  const a = document.getElementById('actions'); a.replaceChildren(
    $('button', { onclick: () => { vscode.postMessage({ type: 'save', policy: P }); dirty = false; }, disabled: !dirty }, dirty ? 'Save roles' : 'Saved'),
    $('button', { class: 'secondary', title: 'Chains built from every model your providers offer, by what each can do — subscriptions first', onclick: () => { P = clone(S.template); changed(); } }, 'Suggest from all models'),
    S && S.custom ? $('button', { class: 'secondary', onclick: () => { dirty = false; vscode.postMessage({ type: 'reset' }); } }, 'Forget my roles') : null,
    $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'refresh' }) }, 'Refresh usage'),
    $('span', { class: 'muted' }, S ? (S.custom ? 'Your roles' : 'Template — from the models enabled as workers, subscriptions first') + (dirty ? ' · unsaved changes (preview below is live; saving enables any model they need)' : '') : ''));
}
function renderInventory() {
  const inv = document.getElementById('inventory');
  const acct = $('div', { class: 'card' }, $('b', {}, S.account.email || 'No signed-in account'), $('div', { class: 'muted' }, 'This window leads on: ' + S.account.login));
  const caps = (o) => [['answer', 'answers'], ['agent', 'agent tasks'], ['image', 'images'], ['vision', 'sees images']].filter(([k]) => o.can[k]).map(([, t]) => $('span', { class: 'badge' }, t));
  const status = (o) => !o.enabled ? $('span', { class: 'muted' }, 'not enabled') : $('span', {}, o.agentEnabled ? 'worker + agent tasks' : 'worker');
  const provs = S.providers.map((p) => $('div', { class: 'card' },
    $('div', { class: 'row' }, $('b', {}, p.name), (p.usage && p.usage.plan) || p.plan ? $('span', { class: 'badge' }, (p.usage && p.usage.plan) || p.plan) : null),
    $('table', {}, ...S.offers.filter((o) => o.providerName === p.name).map((o) => $('tr', { class: o.unavailable ? 'err' : '' }, $('td', {}, $('b', {}, o.model)), $('td', {}, ...caps(o)), $('td', {}, status(o), o.unavailable ? ' — ' + o.unavailable : '', ...o.limits.map((l) => $('div', { class: 'muted' }, l)))))),
    p.usage ? $('div', {}, ...p.usage.windows.map((x) => $('div', { class: 'row' }, $('span', { class: 'muted' }, x.label), $('div', { class: 'track' }, $('div', { class: 'bar', style: 'width:' + Math.min(100, x.usedPct) + '%' })), $('span', { class: x.usedPct >= 90 ? 'warn' : '' }, Math.round(x.usedPct) + '%'), x.resetsAt ? $('span', { class: 'muted' }, 'resets in ' + until(x.resetsAt)) : null)), $('div', { class: 'muted' }, p.usage.source)) : $('div', { class: 'muted' }, p.name === 'Anthropic login' ? "No usage report from Claude Code yet — it caches one as you use it (/usage)." : 'No plan usage reported.')));
  inv.replaceChildren($('div', { class: 'grid' }, acct, ...provs),
    S.offers.length ? null : $('p', {}, 'No providers yet. ', $('a', { onclick: () => vscode.postMessage({ type: 'command', id: 'cppo.editProvider' }) }, 'Enable workers'), ' on a provider, or ', $('a', { onclick: () => vscode.postMessage({ type: 'command', id: 'cppo.addProvider' }) }, 'add one'), '.'));
}
function renderThresholds() {
  const t = document.getElementById('thresholds');
  const num = (key, label) => $('label', { class: 'row' }, label, $('input', { type: 'number', min: 1, max: 100, value: P[key], style: 'width:60px', onchange: (e) => { P[key] = Math.min(100, Math.max(1, Number(e.target.value) || 100)); changed(); } }), '%');
  t.replaceChildren($('div', { class: 'row' }, 'Pass over an entry whose plan has used more than', num('skip5hPct', 'of a 5-hour window:'), num('skipWeeklyPct', 'or of a weekly window:')), $('div', { class: 'muted' }, 'Passed-over entries go to the back of the chain; when every entry is past its threshold, the least-used still serves. 100 = never pass over.'));
}
function renderRoles() {
  const root = document.getElementById('roles'); const out = [];
  let cat = '';
  for (const def of S.catalog) {
    if (def.category !== cat) { cat = def.category; out.push($('h2', {}, cat)); }
    const role = P.roles.find((r) => r.id === def.id) || (P.roles.push({ id: def.id, chain: [] }), P.roles[P.roles.length - 1]);
    const eligible = S.offers.filter((o) => o.can[def.kind === 'image' ? 'image' : def.kind]);
    const pending = (o) => !o.enabled || (def.kind !== 'answer' && !o.agentEnabled);
    const label = (o) => o.id + (o.plan ? '' : ' (per token)') + (pending(o) ? ' — enabled on save' : '');
    const rows = role.chain.map((e, i) => $('tr', {},
      $('td', { class: 'muted' }, String(i + 1) + '.'),
      $('td', {}, $('select', { onchange: (ev) => { e.worker = ev.target.value; changed(); } }, ...eligible.map((o) => $('option', { value: o.id, selected: o.id === e.worker }, label(o))), eligible.some((o) => o.id === e.worker) ? null : $('option', { value: e.worker, selected: true }, e.worker + ' (gone — remove it)'))),
      $('td', {}, $('select', { onchange: (ev) => { e.effort = ev.target.value || undefined; changed(); } }, $('option', { value: '' }, 'model default'), ...S.efforts.map((x) => $('option', { value: x, selected: x === e.effort }, x)))),
      $('td', {}, $('button', { class: 'icon', title: 'Up', disabled: i === 0, onclick: () => { role.chain.splice(i - 1, 0, role.chain.splice(i, 1)[0]); changed(); } }, '↑'), $('button', { class: 'icon', title: 'Down', disabled: i === role.chain.length - 1, onclick: () => { role.chain.splice(i + 1, 0, role.chain.splice(i, 1)[0]); changed(); } }, '↓'), $('button', { class: 'icon', title: 'Remove', onclick: () => { role.chain.splice(i, 1); changed(); } }, '✕'))));
    const unused = eligible.filter((o) => !role.chain.some((e) => e.worker === o.id));
    const served = S.served[def.id] || { order: [], skipped: [] };
    out.push($('div', { class: 'card role' + (role.off ? ' off' : '') },
      $('div', { class: 'row' }, $('b', {}, def.label), $('code', { class: 'muted' }, def.id), $('span', { class: 'badge' }, def.kind === 'answer' ? 'delegate' : def.kind === 'image' ? 'start_task · images' : 'start_task'),
        $('label', { class: 'row', style: 'margin-left:auto' }, $('input', { type: 'checkbox', checked: !role.off, onchange: (ev) => { if (ev.target.checked) delete role.off; else role.off = true; changed(); } }), 'on')),
      $('div', { class: 'muted' }, def.purpose),
      role.chain.length ? $('table', {}, rows) : $('div', { class: 'warn' }, eligible.length ? 'No models in the chain yet — add one below.' : def.kind === 'image' ? 'None of your providers can generate images (OpenAI Codex on a ChatGPT plan or Google AI can).' : def.kind === 'agent' ? 'None of your providers can run agent tasks.' : 'No providers yet.'),
      unused.length ? $('div', { class: 'row' }, $('select', { id: 'add-' + def.id }, ...unused.map((o) => $('option', { value: o.id }, label(o)))), $('button', { class: 'secondary', onclick: () => { role.chain.push({ worker: document.getElementById('add-' + def.id).value, effort: def.effort }); changed(); } }, role.chain.length ? 'Add fallback' : 'Add model')) : null,
      role.off ? null : $('div', { class: 'served' }, served.order.length ? [dirty ? 'Once saved, served by ' : 'Now served by ', $('b', {}, served.order[0]), served.order.length > 1 ? ', then ' + served.order.slice(1).join(' → ') : ''] : $('span', { class: 'err' }, 'Nothing can serve this right now.'), ...served.skipped.map((s) => $('div', { class: 'muted' }, 'Passed over — ' + s)))));
  }
  root.replaceChildren(...out);
}
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'notSaved') { dirty = true; renderActions(); return; }
  if (m.type !== 'state') return;
  S = m; if (!m.draft) { P = clone(m.policy); dirty = false; }
  renderActions(); renderInventory(); renderThresholds(); renderRoles();
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
