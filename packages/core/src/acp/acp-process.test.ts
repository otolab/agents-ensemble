import { describe, expect, it } from 'vitest';
import { SessionLogger } from '../conductor/session/session-logger.js';
import { spawnAcpProcess } from './acp-process.js';

const STDERR_AFTER_STDIN_EOF_SCRIPT = [
  'process.stderr.write("ACP_CHILD_READY\\n");',
  'process.stdin.resume();',
  'process.stdin.once("end", () => {',
  '  process.stderr.write("HARNESS_TEST_STDERR_CAPTURE\\n");',
  '  process.stderr.write("LOGGER_STDERR_LINE\\n");',
  '});',
].join('\n');

const SIGTERM_STDERR_SCRIPT = [
  'process.on("SIGTERM", () => {',
  '  process.stderr.write("ACP_SIGTERM_DIAGNOSTIC\\n");',
  '});',
  'process.stdin.resume();',
  'process.stderr.write("ACP_CHILD_READY\\n");',
  'setInterval(() => {}, 60_000);',
].join('\n');

async function withinTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('spawnAcpProcess', () => {
  it('captures stderr emitted after stdin EOF from a ready child', async () => {
    const captured: string[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const client = await spawnAcpProcess({
      command: process.execPath,
      args: ['-e', STDERR_AFTER_STDIN_EOF_SCRIPT],
      onProcessStdioLine: ({ line }) => {
        captured.push(line);
        if (line === 'ACP_CHILD_READY') resolveReady();
      },
    });

    await ready;
    await client.close();

    expect(captured).toContain('HARNESS_TEST_STDERR_CAPTURE');
  });

  it('forwards stderr emitted after stdin EOF to SessionLogger', async () => {
    const logger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const events: Array<{ line: string; workerName?: string }> = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    logger.subscribe((event) => {
      if (event.type === 'worker.process.stderr') {
        events.push({ line: event.line, workerName: event.workerName });
      }
    });
    const client = await spawnAcpProcess({
      command: process.execPath,
      args: ['-e', STDERR_AFTER_STDIN_EOF_SCRIPT],
      workerName: 'implementer',
      onProcessStdioLine: ({ stream, line, workerName }) => {
        if (stream !== 'stderr') return;
        if (line === 'ACP_CHILD_READY') resolveReady();
        logger.emit({
          type: 'worker.process.stderr',
          line,
          stream: 'stderr',
          workerName,
        });
      },
    });

    await ready;
    await client.close();

    expect(events).toEqual([
      { line: 'ACP_CHILD_READY', workerName: 'implementer' },
      { line: 'HARNESS_TEST_STDERR_CAPTURE', workerName: 'implementer' },
      { line: 'LOGGER_STDERR_LINE', workerName: 'implementer' },
    ]);
  });

  it(
    'captures and logs SIGTERM diagnostics before force-killing the ACP child',
    async () => {
      const logger = new SessionLogger({
        issueUrl: 'https://github.com/org/repo/issues/1',
        repoRoot: '/repo',
      });
      const captured: string[] = [];
      const events: Array<{ line: string; workerName?: string }> = [];
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      logger.subscribe((event) => {
        if (event.type === 'worker.process.stderr') {
          events.push({ line: event.line, workerName: event.workerName });
        }
      });

      const client = await spawnAcpProcess({
        command: process.execPath,
        args: ['-e', SIGTERM_STDERR_SCRIPT],
        workerName: 'implementer',
        onProcessStdioLine: ({ stream, line, workerName }) => {
          if (stream !== 'stderr') return;
          captured.push(line);
          logger.emit({
            type: 'worker.process.stderr',
            line,
            stream,
            workerName,
          });
          if (line === 'ACP_CHILD_READY') resolveReady();
        },
      });

      await withinTimeout(ready, 2_000);
      const child = client.childProcess;
      if (!child) throw new Error('Expected spawnAcpProcess to own a child');
      let childExited = false;
      child.once('exit', () => {
        childExited = true;
      });
      const closeStartedAt = Date.now();
      await withinTimeout(client.close(), 7_500);

      expect(Date.now() - closeStartedAt).toBeLessThan(7_500);
      expect(childExited).toBe(true);
      expect(child.signalCode).toBe('SIGKILL');
      expect(child.exitCode).toBeNull();
      expect(captured).toContain('ACP_SIGTERM_DIAGNOSTIC');
      expect(events).toContainEqual({
        line: 'ACP_SIGTERM_DIAGNOSTIC',
        workerName: 'implementer',
      });
    },
    9_000,
  );
});
