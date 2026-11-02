import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { hasCredentials } from './accounts';
import { workingRoot } from './workdir';
import { log } from './log';

/**
 * The extension's persistent state, kept on THIS host's disk.
 *
 * Why not globalState
 * ───────────────────
 * `context.globalState` looks per-host but is not: VSCode stores it on the CLIENT
 * (the machine running the UI), so every remote host an editor connects to reads
 * and writes the very same copy. Everything kept here describes one host's
 * filesystem — account stores are paths on it, the repo map is keyed by folder
 * paths on it — so sharing it across hosts is meaningless at best. At worst it is a
 * war: each host's reconcile prunes every account whose store isn't on ITS disk,
 * which is every account of the other host, and whichever host looks next re-adds
 * its own and prunes the rest. Windows on both sides kept losing their account and
 * reloading, back and forth, for as long as both hosts were in use.
 *
 * A file under ~/.claude-windows is shared by exactly the windows that share the
 * disk it describes — every window on this host, and no window anywhere else. It
 * is also read fresh on every access, so windows on the same host agree on the
 * account list without waiting for a restart.
 */

const KEYS = [
  'claudeProfiles.accounts',
  'claudeProfiles.forgottenAccounts',
  'claudeProfiles.lastAccount',
  'claudeProfiles.repoAccounts',
  /** Providers by account email — see providers.ts. */
  'claudeProfiles.providers',
  /** Set once this host adopted the providers older versions kept in globalState. */
  'claudeProfiles.providersMigrated',
  /** A random id for this host, naming its provider keys in the client's secret storage. */
  'claudeProfiles.hostId',
  /** Claude models on each account's own Anthropic login enabled as workers, by email. */
  'claudeProfiles.loginWorkers',
  /** Set once this host's existing account stores were sorted into created vs adopted (accounts.ts). */
  'claudeProfiles.storesClassified',
  /** Roles and their fallback chains (roles.ts), by account email. */
  'claudeProfiles.roles',
  /** Codex providers whose shared host sign-in the user already confirmed (by provider id). */
  'claudeProfiles.codexSharedAck',
  /** Google AI providers whose shared host sign-in the user already confirmed. */
  'claudeProfiles.googleSharedAck',
] as const;
export type HostStateKey = (typeof KEYS)[number];

type Entry = { name: string; dir: string };

function statePath(): string {
  return path.join(workingRoot(), '.state.json');
}

function backupPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cppo', 'state.backup.json');
}

let backupFailureLogged = false;
let recoveryRecorded = false;
let recoveryNotice: string | undefined;

/** Returns a recovery message once, so callers can tell the user what happened. */
export function takeRecoveryNotice(): string | undefined {
  const notice = recoveryNotice;
  recoveryNotice = undefined;
  return notice;
}

function parseState(file: string): Partial<Record<HostStateKey, unknown>> {
  const state: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Host state is not an object');
  }
  return state as Partial<Record<HostStateKey, unknown>>;
}

export class HostState {
  /** Read synchronously: activation binds the window before Claude Code starts. */
  private read(): Partial<Record<HostStateKey, unknown>> {
    try {
      return parseState(statePath());
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      try {
        const state = parseState(backupPath());
        if (!recoveryRecorded) {
          recoveryRecorded = true;
          recoveryNotice = `CPPO's saved state (providers, roles, accounts) was ${reason} on this host and was restored from its backup. If the extension's ID changed since, provider keys kept by VS Code may need to be entered again.`;
          log(recoveryNotice);
        }
        return state;
      } catch {
        return {}; // neither copy is available — same as empty
      }
    }
  }

  private write(state: Partial<Record<HostStateKey, unknown>>): void {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Per-process temp name: several windows on this host can write at once.
    const tmp = `${file}.${process.pid}.tmp`;
    const json = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic: a reader never sees half a file
    // Keep a second copy outside the tree old uninstall scripts remove.
    try {
      const backup = backupPath();
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      const backupTmp = `${backup}.${process.pid}.tmp`;
      fs.writeFileSync(backupTmp, json, { mode: 0o600 });
      fs.renameSync(backupTmp, backup);
    } catch (err) {
      if (!backupFailureLogged) {
        backupFailureLogged = true;
        log(`could not back up host state: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Makes sure the backup exists and isn't older than the main file. write() keeps
   * it current, but a host that rarely writes (or whose state was last written by
   * an older version, which made no backup) would otherwise have none when the
   * main file is lost. Cheap: two stats at activation.
   */
  ensureBackup(): void {
    try {
      const main = fs.statSync(statePath());
      let stale = true;
      try {
        stale = fs.statSync(backupPath()).mtimeMs < main.mtimeMs;
      } catch {
        /* no backup yet */
      }
      if (stale) this.write(this.read());
    } catch {
      /* no main file (nothing to back up), or unreadable — read() handles those */
    }
  }

  get<T>(key: HostStateKey): T | undefined;
  get<T>(key: HostStateKey, defaultValue: T): T;
  get<T>(key: HostStateKey, defaultValue?: T): T | undefined {
    const value = this.read()[key];
    return value === undefined ? defaultValue : (value as T);
  }

  /** Mirrors Memento.update, so callers read the same as with globalState. */
  async update(key: HostStateKey, value: unknown): Promise<void> {
    const state = this.read();
    if (value === undefined) delete state[key];
    else state[key] = value;
    this.write(state);
  }

  /**
   * One-time adoption of the state older versions kept in globalState, run on each
   * host the first time this version activates there.
   *
   * That state was shared by every host, so this host keeps only what is
   * provably its own:
   *   • accounts whose store holds a token HERE;
   *   • forgotten accounts whose store is here and signed OUT — a forget always
   *     signs the store out on the host that did it, so a forgotten store still
   *     holding a live token here was "forgotten" by another host's war, not by
   *     the user, and hiding it would lose a working account;
   *   • repo entries for folders that exist here, naming an account kept above;
   *   • the last-used account, if it was kept.
   * Anything dropped that is really this host's is found again on disk by
   * discoverAndMerge().
   *
   * globalState is left untouched: a host still on an older version keeps reading
   * it, and nothing here reads it again once the file exists.
   */
  migrateFrom(globalState: vscode.Memento): void {
    if (fs.existsSync(statePath()) || fs.existsSync(backupPath())) return;
    const accounts = globalState
      .get<Entry[]>('claudeProfiles.accounts', [])
      .filter((a) => hasCredentials(a.dir));
    const names = new Set(accounts.map((a) => a.name));
    const forgotten = globalState
      .get<Entry[]>('claudeProfiles.forgottenAccounts', [])
      .filter((a) => fs.existsSync(a.dir) && !hasCredentials(a.dir));
    const repos = Object.fromEntries(
      Object.entries(globalState.get<Record<string, string>>('claudeProfiles.repoAccounts', {})).filter(
        ([folder, name]) => names.has(name) && fs.existsSync(folder)
      )
    );
    const last = globalState.get<string>('claudeProfiles.lastAccount');

    const state: Partial<Record<HostStateKey, unknown>> = {
      'claudeProfiles.accounts': accounts,
      'claudeProfiles.forgottenAccounts': forgotten,
      'claudeProfiles.repoAccounts': repos,
    };
    if (last && names.has(last)) state['claudeProfiles.lastAccount'] = last;
    try {
      this.write(state);
      log(
        `migrated state to this host: accounts=${accounts.length} forgotten=${forgotten.length} ` +
          `repos=${Object.keys(repos).length} last=${state['claudeProfiles.lastAccount'] ?? '(none)'}`
      );
    } catch (err) {
      log(`could not write host state: ${(err as Error).message}`);
    }
  }
}
