import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { log } from './log';
import { readIdentity } from './accounts';
import { LIMIT_SNIPPET } from './proc';

/**
 * Thin wrapper around the `claude` CLI's auth commands, scoped to a specific
 * CLAUDE_CONFIG_DIR. This is the AUTHORITATIVE source of an account's identity:
 * `claude auth status` reflects the real OAuth token, so it can never disagree
 * with what Claude Code actually bills to (unlike reading .claude.json, whose
 * oauthAccount field can drift out of sync with the token).
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/**
 * The Claude Code extension's own binary — the version this window's chats
 * actually run. A `claude` on PATH can be far older (one host had an npm
 * global 2.1.81 next to the extension's 2.1.301, and the old one started
 * headless gateway runs in "default" permission mode, so every edit was
 * denied). Undefined when that extension isn't installed here.
 */
export function bundledClaude(): string | undefined {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (!ext) return undefined;
  const bin = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    return undefined;
  }
}

/**
 * Shell arguments that run Claude Code with `args`: the extension's binary when
 * there is one, else `claude` from PATH. Through a login shell either way, so
 * the commands an agent runs see the user's PATH (nvm and the like).
 *
 * With `limitSec`, the trampoline instead wraps the run in `timeout` (proc.ts
 * LIMIT_SNIPPET): a detached agent task gets a hard wall that ends it even if
 * the extension host that started it is gone. The caller must set CPPO_LIMIT_S
 * in the environment. Other callers (consultations) keep the plain exec.
 */
export function claudeShellArgs(args: string[], limitSec?: number): string[] {
  const bin = bundledClaude();
  if (limitSec === undefined) return bin ? ['-lc', 'exec "$0" "$@"', bin, ...args] : ['-lc', 'exec claude "$@"', 'claude', ...args];
  return bin ? ['-lc', LIMIT_SNIPPET, bin, ...args] : ['-lc', LIMIT_SNIPPET, 'claude', ...args];
}

/** Runs a claude CLI command through a login shell so nvm/PATH resolve. */
function runClaude(args: string, dir: string, timeoutMs: number): Promise<string> {
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((resolve, reject) => {
    // execFile's own `timeout` sends SIGTERM, which a login shell can trap and
    // ignore — leaving the callback pending forever. Escalate to SIGKILL and
    // back it with our own hard timer so this promise ALWAYS settles.
    const child = execFile(
      shell,
      ['-lc', `claude ${args}`],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        clearTimeout(hardTimer);
        if (err) reject(new Error(stderr?.toString() || err.message));
        else resolve(stdout.toString());
      }
    );
    const hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(`claude ${args} timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
  });
}

/**
 * Returns the authenticated account for a config dir, or null if the CLI call
 * fails or the dir isn't logged in. Never throws.
 */
export async function getAuthStatus(
  dir: string,
  timeoutMs = 15000
): Promise<AuthStatus | null> {
  try {
    const out = await runClaude('auth status --json', dir, timeoutMs);
    const parsed = JSON.parse(out) as AuthStatus;
    // Recent Claude Code versions (2.1.x) return `email: null` from
    // `auth status --json` even when logged in via claude.ai. The email still
    // lives in the account's .claude.json (oauthAccount.emailAddress), so fall
    // back to it — otherwise every identity-dependent flow (capture, switch,
    // dedupe-by-email) silently bails out with "no signed-in account".
    if (parsed.loggedIn && !parsed.email) {
      const id = readIdentity(dir);
      if (id?.email) {
        parsed.email = id.email;
        if (!parsed.orgName && id.organizationName) parsed.orgName = id.organizationName;
      }
    }
    log(`auth status(${dir}): loggedIn=${parsed.loggedIn} email=${parsed.email ?? '(none)'}`);
    return parsed;
  } catch (err) {
    log(`auth status(${dir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}
