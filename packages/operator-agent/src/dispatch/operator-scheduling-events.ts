import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_PENDING = 1000;
const SHUTDOWN_WAIT_MS = 500;

/** The writer owns all event filesystem operations in a separate process. */
export function createSchedulingEventWriter(
  root: string,
  profile: string,
  onError?: (message: string) => void,
  configScope?: string,
) {
  let child: ChildProcess | undefined;
  let pending = 0;
  let closed = false;
  let nextId = 0;
  const barriers = new Map<number, () => void>();
  const warn = (message: string) => {
    queueMicrotask(() => { try { onError?.(message); } catch { /* diagnostic only */ } });
  };
  const finishBarriers = () => { for (const resolve of barriers.values()) resolve(); barriers.clear(); };
  try {
    const writerUrl = import.meta.url.endsWith('.ts')
      ? new URL('../../dist/dispatch/operator-scheduling-writer.js', import.meta.url)
      : new URL('./operator-scheduling-writer.js', import.meta.url);
    child = fork(
      fileURLToPath(writerUrl),
      [root, profile, configScope ?? ''],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] },
    );
    child.unref();
    child.channel?.unref();
    child.on('message', (message: { type?: string; id?: number; message?: string }) => {
      if (message.type === 'event') {
        pending = Math.max(0, pending - 1);
        if (message.message) warn(`scheduling event write failed: ${message.message}`);
      } else if (message.type === 'barrier' && typeof message.id === 'number') {
        barriers.get(message.id)?.();
        barriers.delete(message.id);
      }
    });
    child.on('error', (error) => { warn(`scheduling event writer failed: ${error.message}`); finishBarriers(); });
    child.on('exit', (code) => {
      if (pending > 0 || (!closed && code !== 0)) warn(`scheduling event writer exited; ${pending} pending event(s) may be lost`);
      child = undefined;
      finishBarriers();
    });
  } catch (error) {
    warn(`scheduling event writer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const send = (message: object) => {
    if (!child?.connected) return false;
    try {
      child.send(message, (error) => { if (error) warn(`scheduling event writer IPC failed: ${error.message}`); });
      return true;
    } catch (error) {
      warn(`scheduling event writer IPC failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const flush = async (timeoutMs: number) => {
    if (!child?.connected) return;
    const id = ++nextId;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        barriers.delete(id);
        warn('scheduling event flush timed out; pending events may be lost');
        resolve();
      }, timeoutMs);
      barriers.set(id, () => { clearTimeout(timer); resolve(); });
      if (!send({ type: 'barrier', id })) { clearTimeout(timer); barriers.delete(id); resolve(); }
    });
  };
  let closePromise: Promise<void> | undefined;
  return {
    record(event: Record<string, unknown>) {
      if (closed || pending >= MAX_PENDING) {
        warn('scheduling event buffer is unavailable or full');
        return;
      }
      pending++;
      if (!send({ type: 'event', event })) pending--;
    },
    flush: () => closePromise ?? flush(5000),
    close() {
      if (closed) return;
      closed = true;
      closePromise = flush(SHUTDOWN_WAIT_MS).finally(() => {
        try { if (child?.connected) child.disconnect(); } catch { /* already gone */ }
        child?.kill();
      });
    },
  };
}
