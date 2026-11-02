import * as fs from 'fs';

export interface TaskView {
  id: string;
  worker: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  minutes: number;
  turns: number;
  lastAction?: string;
  files: number;
  applied: boolean;
}

const TASK_ID = 't[a-z0-9]{9,}';

/** Only tool results tell us what this session started and actually read. */
export function sessionTasks(transcript: string): { started: string[]; read: Set<string> } {
  const started = new Set<string>();
  const read = new Set<string>();
  for (const line of transcript.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev?.type !== 'user' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) {
        if (block?.type !== 'tool_result') continue;
        const texts = typeof block.content === 'string' ? [block.content] : Array.isArray(block.content)
          ? block.content.filter((b: { type?: string; text?: unknown }) => b?.type === 'text' && typeof b.text === 'string').map((b: { text: string }) => b.text) : [];
        for (const value of texts) {
          const text = value.trimStart();
          const start = text.match(new RegExp(`^(?:Started|Queued) task (${TASK_ID})\\b`));
          if (start) started.add(start[1]);
          const finished = text.match(new RegExp(`^(?:Task (${TASK_ID}): (?:done|failed|cancelled)\\b|Applied task (${TASK_ID})\\b)`));
          if (finished) read.add(finished[1] ?? finished[2]);
          if (/^(?:Applied the chain |Nothing to apply: )/.test(text)) {
            for (const id of text.match(new RegExp(`\\b${TASK_ID}\\b`, 'g')) ?? []) read.add(id);
          }
        }
      }
    } catch {
      /* Partial or unrelated transcript lines don't prevent a stop. */
    }
  }
  return { started: [...started], read };
}

export function readTranscriptTail(file: string, maxBytes = 16 * 1024 * 1024): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(0, Math.floor(maxBytes)));
    const buffer = Buffer.alloc(size - start);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
      if (!n) break;
      bytes += n;
    }
    const text = buffer.subarray(0, bytes).toString('utf-8');
    return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function decideStop(o: { transcript: string; task: (id: string) => TaskView | undefined; blocksInARow: number; maxBlocks?: number }): { block: boolean; reason?: string } {
  if (o.blocksInARow >= (o.maxBlocks ?? 60)) return { block: false };
  const session = sessionTasks(o.transcript);
  const tasks = session.started.map(o.task).filter((t): t is TaskView => Boolean(t));
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
  if (running.length) {
    const describe = (t: TaskView) => `Agent task ${t.id} on ${t.worker} is ${t.status === 'queued' ? 'queued' : 'still running'} (${t.minutes} min, ${t.turns} turns; last: ${t.lastAction ?? '—'}).`;
    return {
      block: true,
      reason: running.slice(0, 5).map(describe).join('\n') + (running.length > 5 ? `\n…and ${running.length - 5} more.` : '') +
        `\nDon't end your turn while ${running.length === 1 ? 'it runs' : 'they run'}: call wait_task with task_id "${running[0].id}" now (it waits up to 4 minutes) and keep calling it until ${running.length === 1 ? 'it is' : 'each is'} done${running.length > 1 ? ', waiting for them one by one' : ''}, then review the result and apply or report it.`,
    };
  }
  const unread = tasks.find((t) => !session.read.has(t.id));
  if (unread) return {
    block: true,
    reason: `Agent task ${unread.id} on ${unread.worker} has finished but you haven't read its result. Call wait_task with task_id "${unread.id}" to get its report and diff, review it, then apply it with apply_task_changes or tell the user why not.`,
  };
  return { block: false };
}
