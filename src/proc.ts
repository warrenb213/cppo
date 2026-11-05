import * as fs from 'fs';

/**
 * Small Linux-only process helpers, pure Node (no vscode) so they can be unit
 * tested outside the extension host.
 */

/**
 * The shell trampoline every agent run goes through: `exec` so the spawned pid
 * IS the run's session leader, and — when the host has `timeout` — a hard wall
 * that ends the run even if no extension host is watching it anymore (the host
 * restarts; the run must not outlive its limit). `timeout` gets its limit
 * through CPPO_LIMIT_S; without `timeout` the run simply execs directly.
 */
export const LIMIT_SNIPPET =
  'if command -v timeout >/dev/null 2>&1; then exec timeout -k 15 "$CPPO_LIMIT_S" "$0" "$@"; else exec "$0" "$@"; fi';

/**
 * Pids in session `sid`, via /proc. A run's agent is spawned detached (its own
 * session), but `timeout` moves its command to a new process GROUP and a shell
 * command may spawn its own sessions — so the only reliable set is "everything
 * whose session id matches". `comm` can contain spaces and parens, so the stat
 * line is parsed AFTER its last ')': field 3 (state) is then fields[0] and
 * field 6 (session) is fields[3]. Zombies are skipped — a reaped leader shows
 * up as one until the host waits on it.
 */
export function sessionPids(sid: number): number[] {
  if (!sid || process.platform !== 'linux') return [];
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf-8');
    } catch {
      continue; // gone between readdir and read
    }
    const end = stat.lastIndexOf(')');
    if (end < 0) continue;
    const fields = stat.slice(end + 2).split(/\s+/);
    if (fields[0] === 'Z' || Number(fields[3]) !== sid) continue;
    out.push(Number(name));
  }
  return out;
}

/** Signals every process in the session; ESRCH (already gone) is fine. */
export function killSession(sid: number, signal: NodeJS.Signals): void {
  for (const pid of sessionPids(sid)) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
