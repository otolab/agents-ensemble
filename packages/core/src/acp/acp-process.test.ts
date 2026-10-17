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
});
