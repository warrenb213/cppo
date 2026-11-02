import * as vscode from 'vscode';
import { AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { log } from './log';
import { WindowBinding } from './binding';
import { getAuthStatus, AuthStatus } from './cli';
import { defaultSourceDir } from './capture';
import { ProviderManager, describeLogin, describeModels } from './providers';
import type { AgentTasks } from './agentTasks';
import type { Transcripts } from './transcripts';
import { selfId } from './copies';

/** Marketplace id — the hover links to the extension's own page with it. */

/**
 * Status bar item showing the account bound to THIS window. The displayed
 * identity is confirmed asynchronously via `claude auth status` (the real
 * token), so it never shows a stale identity when another window switches
 * accounts or when a config file drifts out of sync with the token.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** Authoritative status per dir, filled in asynchronously. */
  private readonly statusCache = new Map<string, { status: AuthStatus | null; at: number }>();
  /**
   * How long a CLI confirmation stays trusted. The user can re-login inside
   * Claude Code itself at any moment (/login), which this extension can't
   * observe — so a cached identity must expire, or the status bar would show
   * the old account until the next reload.
   */
  private static readonly STATUS_TTL_MS = 60_000;

  constructor(
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding,
    private readonly providers: ProviderManager
  ) {
    this.item = vscode.window.createStatusBarItem(
      'cppo.status',
      vscode.StatusBarAlignment.Right,
      90
    );
    this.item.command = 'cppo.showStatus';
    this.item.name = 'Claude Account';
    this.disposables.push(
      this.binding.onDidChange.event(() => {
        const dir = this.binding.getEnvDir();
        if (dir) this.statusCache.delete(dir); // force re-confirm after a switch
        this.refresh();
      }),
      this.providers.onDidChange.event(() => this.render()),
      // Coming back to the window is the natural moment the account may have
      // changed behind our back (e.g. /login in the Claude Code panel).
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.refresh();
      })
    );
  }

  initialize(): void {
    this.item.show();
    this.refresh();
  }

  /**
   * Force a re-confirmation of this window's account and repaint. Called by the
   * account watcher when an identity file changes, so the bar never lags behind
   * an account switch made in Claude Code.
   */
  reconfirm(): void {
    this.statusCache.delete(this.effectiveDir());
    this.refresh();
  }

  /**
   * The data dir this window's Claude Code is effectively using: the bound
   * account if any, otherwise the default ~/.claude. We always resolve to
   * something so the status bar reflects the *actual* active account, even
   * before the user has saved/bound anything.
   */
  private effectiveDir(): string {
    return this.binding.getEnvDir() ?? defaultSourceDir();
  }

  /** Dirs with a CLI confirmation currently in flight (dedupes focus events). */
  private readonly pendingDirs = new Set<string>();

  /** The CLI-confirmed status for a dir, if still fresh. */
  private cachedStatus(dir: string): AuthStatus | null | undefined {
    return this.statusCache.get(dir)?.status;
  }

  /** Renders from cache immediately, then confirms via the CLI in the background. */
  private refresh(): void {
    this.render();
    const dir = this.effectiveDir();
    const entry = this.statusCache.get(dir);
    if (entry && Date.now() - entry.at < StatusBarManager.STATUS_TTL_MS) return;
    // Each confirmation spawns a login shell + the claude CLI; window-focus
    // events can arrive in bursts, so never run two for the same dir at once.
    if (this.pendingDirs.has(dir)) return;
    this.pendingDirs.add(dir);
    void getAuthStatus(dir).then((status) => {
      this.pendingDirs.delete(dir);
      this.statusCache.set(dir, { status, at: Date.now() });
      this.render();
    });
  }

  /**
   * What this window's account REALLY is.
   *
   * The identity file outlives the token: after a `/logout` — or a forget in
   * another window — `.credentials.json` is gone but `.claude.json` still names
   * the account. So the identity file alone must NEVER be enough to claim
   * "signed in", or the bar happily shows a signed-out account as if nothing
   * happened. Ground truth is the token file plus the CLI's verdict; the
   * identity is only a fast fallback for the email while the CLI is still
   * answering. (A confirmed `loggedIn` without a token file is still trusted —
   * that's an API-key setup, which keeps no `.credentials.json`.)
   *
   * The three cached states are NOT interchangeable and collapsing them is a bug:
   *   undefined → not asked yet
   *   null      → the CLI could not be run (no `claude` on PATH, timeout)
   *   object    → the CLI answered; `loggedIn` is then the verdict
   * Treating `null` as "signed out" put a warning badge and "Claude: sign in" on
   * a perfectly signed-in window whose only sin was a `claude` binary the
   * extension host couldn't reach. A failed question is not a negative answer:
   * fall back to the files on disk, and just say it isn't confirmed.
   */
  private resolve(dir: string): {
    email?: string;
    signedOut: boolean;
    confirmed: boolean;
    unreachable: boolean;
  } {
    const status = this.cachedStatus(dir);
    const unreachable = status === null;
    const cliSaysIn = status?.loggedIn === true;
    const cliSaysOut = status !== undefined && status !== null && status.loggedIn !== true;
    const signedOut = cliSaysOut || (!hasCredentials(dir) && !cliSaysIn);
    return {
      email: signedOut ? undefined : status?.email ?? readIdentity(dir)?.email,
      signedOut,
      confirmed: cliSaysIn,
      unreachable,
    };
  }

  /**
   * The hover card. VSCode can't anchor a real menu to a status bar item, but a
   * trusted-markdown hover CAN hold command links — so this doubles as the item's
   * menu, and it's the only surface the user ever sees. It therefore has to say
   * WHOSE item this is: an unlabelled email in the status bar is a mystery, and
   * there is no other affordance to find the extension, its settings, or its log.
   */
  private card(sections: string[]): vscode.MarkdownString {
    const arg = (v: unknown) => encodeURIComponent(JSON.stringify(v));
    // No "Settings" link: the extension deliberately has none, and a gear that
    // opens an empty settings page is worse than no gear at all.
    const links = [
      `[$(extensions) Extension](command:extension.open?${arg([selfId || 'BeboutItSolutions.cppo'])} "Open the extension page")`,
      `[$(output) Log](command:cppo.showLog "Show what this extension has been doing")`,
    ].join(' &nbsp;·&nbsp; ');

    const body = sections.filter(Boolean).join('\n\n');
    const md = new vscode.MarkdownString(
      `$(account) **CPPO**\n\n${body}\n\n---\n\n${links}`
    );
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
  }

  private agentTasks: AgentTasks | undefined;
  private transcripts: Transcripts | undefined;

  /**
   * Agent tasks join the account's card: their state in the hover, a count in the
   * text while active. Each task and worker there links to its transcripts.
   */
  setAgentTasks(tasks: AgentTasks, transcripts: Transcripts, consulted: vscode.Event<unknown>): void {
    this.agentTasks = tasks;
    this.transcripts = transcripts;
    this.disposables.push(tasks.onDidChange.event(() => this.render()), consulted(() => this.render()));
  }

  private render(): void {
    const dir = this.effectiveDir();
    const active = this.binding.getActiveName();
    const savedName = this.registry.getByDir(dir)?.name;

    const status = this.cachedStatus(dir);
    const { email, signedOut, confirmed, unreachable } = this.resolve(dir);
    const notLoggedIn = signedOut;

    if (email) {
      // The email IS the identity — no internal label in front of it. The only
      // extra glyph is ○ = "not saved yet"; its meaning is spelled out in the
      // tooltip. No spinner while re-confirming: a blinking icon next to a
      // perfectly fine account reads as a problem that isn't there.
      // "Saved" means this ACCOUNT (by email) is saved somewhere — not that
      // this exact dir is a registry entry. Otherwise a window sitting on the
      // default dir shows ○ even though the same account was already saved as a
      // named copy in another window.
      const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
      const isSaved = Boolean(savedName || active || savedByEmail);
      // The provider goes in the TEXT, not just the hover: Claude Code's own panel
      // keeps showing the Anthropic login while a gateway is billing, so this is
      // the one place that says where requests actually go.
      const provider = this.providers.active();
      const tasks = this.agentTasks?.summary();
      this.item.text = `$(account) ${email}${isSaved ? '' : ' $(circle-outline)'}${
        provider ? ` · ${provider.name}` : ''
      }${tasks?.active ? ` · $(sync~spin) ${tasks.active}` : ''}`;
      const workers = this.providers.workers();
      // The tooltip doubles as the action menu: VSCode cannot anchor a real
      // menu to a status bar item, but a trusted-markdown hover CAN hold
      // command links — so the actions appear right above the button.
      // Count accounts by distinct email so a duplicated-email copy doesn't look
      // like a separate account to switch to.
      const unique = this.registry.listUniqueByEmail();
      const hasOthers = unique.some((a) => this.registry.emailOf(a) !== email);
      // The hover card is the FULL menu (incl. rare actions like Forget);
      // clicking the item fast-paths straight to the one meaningful action.
      const actions = [
        !isSaved ? '[$(save) Save this account](command:cppo.captureAccount "Save it so you can switch back to it later")' : '',
        hasOthers ? '[$(arrow-swap) Switch account](command:cppo.switchAccount "Pick another account for this window")' : '',
        '[$(credit-card) Switch provider](command:cppo.switchProvider "Bill this window to its Anthropic login, an Anthropic API key, or a gateway such as Poe")',
        tasks?.lines.length
          ? '[$(checklist) Agent tasks](command:cppo.showAgentTasks "Open a task\'s log or patch, or cancel it")'
          : '',
        workers.length ? '[$(graph) Usage](command:cppo.showUsage "How much of each worker provider\'s plan is used")' : '',
        workers.length ? '[$(type-hierarchy) Orchestration](command:cppo.showOrchestration "Which models serve which work, at what effort, with what fallbacks")' : '',
        unique.length > 0
          ? '[$(trash) Forget…](command:cppo.removeProfile "Sign the account out and remove it from the list")'
          : '',
      ].filter(Boolean);
      this.item.tooltip = this.card([
        `**${email}**${status?.subscriptionType ? ` · ${status.subscriptionType}` : ''}${status?.orgName ? ` · ${status.orgName}` : ''}`,
        `This window runs this account. Other windows can run others at the same time.`,
        provider?.kind === 'anthropic'
          ? `$(credit-card) Billing to **${provider.name}** — an Anthropic API key, per token. The account's ` +
            `login stays saved but unused until you switch back to **Anthropic**.`
          : provider
            ? `$(credit-card) Billing to **${provider.name}** (${
                provider.kind === 'codex' ? 'an OpenAI API key, per token, through the local proxy' : `\`${provider.baseUrl}\``
              }) — the Anthropic login stays saved but unused until you switch back.` +
              (describeModels(provider) ? `\n\nModels: ${describeModels(provider)}` : '') +
              (provider.extraModels?.length && provider.kind !== 'codex'
                ? ` · plus ${provider.extraModels.length} non-Claude through the local proxy`
                : '')
            : `$(credit-card) Billing to **Anthropic** — ${describeLogin(dir)}.`,
        workers.length
          ? `$(organization) Workers: ${workers
              .map((w) => {
                const n = this.transcripts?.count(w.id) ?? 0;
                const link = `[${w.id}](command:cppo.showWorkerTranscripts?${encodeURIComponent(JSON.stringify([w.id]))} "Its tasks and consultations in this window")`;
                return `${link}${w.kind === 'google' ? ' (Google AI plan; edit-only)' : ''}${n ? ` (${n})` : ''}${w.agent ? ' _(+agent tasks)_' : ''}`;
              })
              .join(', ')}`
          : '',
        tasks?.lines.length ? `**Agent tasks**${tasks.active ? ` — ${tasks.active} active` : ''}\n\n${tasks.lines.map((l) => `- ${l}`).join('\n')}` : '',
        `Accounts saved: **${unique.length}**${
          this.binding.rememberedForFolder() ? ' · _auto-selected: this folder used it last time_' : ''
        }`,
        !isSaved ? '_$(circle-outline) Not saved yet — saving lets you switch back to it later._' : '',
        unreachable
          ? '_Could not run `claude auth status` (is the `claude` CLI on your PATH?) — showing the ' +
            'account from its config file, which may lag behind the real token._'
          : confirmed
            ? ''
            : '_Confirming with `claude auth status`…_',
        actions.join(' &nbsp;·&nbsp; '),
      ]);
      this.item.backgroundColor = undefined;
    } else if (notLoggedIn) {
      // Signed out: no token in this dir, or the CLI says so. The account this
      // dir used to hold may still be NAMED in its .claude.json (identity
      // outlives the token) — say so instead of pretending it's still active.
      const wasEmail = readIdentity(dir)?.email;
      this.item.text = '$(account) Claude: sign in';
      this.item.tooltip = this.card([
        `**Not signed in**`,
        wasEmail
          ? `This window last ran **${wasEmail}**, but that account is signed out here — a \`/logout\`, ` +
            `or it was forgotten. Claude Code may keep showing it until the window reloads.`
          : `No Claude account is signed in for this window.`,
        `Sign in with Claude Code (Account menu → Login, or \`/login\` in a chat) and the account is ` +
          `saved here automatically — no extra step.`,
        `_If you ARE signed in, check that the \`claude\` CLI is on your PATH._`,
        this.registry.listUniqueByEmail().length > 0
          ? '[$(arrow-swap) Switch account](command:cppo.switchAccount "Use one of your saved accounts in this window")'
          : '',
      ]);
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      // Still confirming for the first time.
      this.item.text = '$(account) Claude $(sync~spin)';
      this.item.tooltip = this.card(['Reading the Claude account this window is signed in as…']);
      this.item.backgroundColor = undefined;
    }
  }

  /**
   * Status bar click = the one action that makes sense right now, directly —
   * no intermediate action list (VSCode cannot anchor a popup to the status
   * bar anyway; the hover card is the full menu, including rare actions).
   */
  async onClick(): Promise<void> {
    const dir = this.effectiveDir();
    const { email } = this.resolve(dir);
    // Saved is by EMAIL, not by this exact dir: a window on the default dir can
    // still be an account that was saved (as a named copy) elsewhere.
    const savedByEmail = email ? this.registry.savedForEmail(email) : undefined;
    const others = this.registry
      .listUniqueByEmail()
      .filter((a) => this.registry.emailOf(a) !== email);
    log(
      `onClick: dir=${dir} email=${email ?? '(none)'} saved=${savedByEmail?.name ?? '(no)'} others=${others.length}`
    );

    // Don't claim "not signed in" while the very first CLI confirmation is
    // still running — that's a false alarm during the initial seconds.
    if (!email && !this.statusCache.has(dir)) {
      vscode.window.showInformationMessage(
        'Still reading the current Claude account — try again in a moment.'
      );
      return;
    }
    if (!email) {
      // Signed out is exactly when the user most needs the saved accounts —
      // e.g. this window's account was forgotten but others exist. A bare
      // "go sign in" here would hide a one-click way out.
      if (this.registry.listUniqueByEmail().length > 0) {
        await vscode.commands.executeCommand('cppo.switchAccount');
        return;
      }
      vscode.window.showWarningMessage(
        'No signed-in Claude account. Sign in in the Claude Code panel (its account menu, or /login ' +
          'in the chat) — the account is saved here automatically.'
      );
      return;
    }
    if (others.length > 0) {
      // There is something to switch to. (A new account is saved on its own by
      // reconcile; *Save* in the hover covers the rare case it wasn't.)
      await vscode.commands.executeCommand('cppo.switchAccount');
      return;
    }
    if (!savedByEmail) {
      // Nothing to switch to, current account not saved → saving is the only move.
      await vscode.commands.executeCommand('cppo.captureAccount');
      return;
    }
    // Single saved account and it's the current one — teach the next step.
    vscode.window.showInformationMessage(
      `${email} is your only saved account. To add another one: sign in as it in Claude Code (/login), then click here to save it.`
    );
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
