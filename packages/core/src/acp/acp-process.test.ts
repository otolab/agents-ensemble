import { describe, expect, it } from 'vitest';
import { SessionLogger } from '../conductor/session/session-logger.js';
import { spawnAcpProcess } from './acp-process.js';

describe('spawnAcpProcess', () => {
  it('captures child stderr without inheriting to parent TTY', async () => {
    const captured: string[] = [];
    const client = await spawnAcpProcess({
      command: process.execPath,
      args: ['-e', 'console.error("HARNESS_TEST_STDERR_CAPTURE")'],
      onProcessStdioLine: ({ line }) => {
        captured.push(line);
      },
    });

    await client.close();

    expect(captured).toContain('HARNESS_TEST_STDERR_CAPTURE');
  });

  it('forwards stderr lines to SessionLogger via onProcessStdioLine', async () => {
    const logger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const events: Array<{ line: string; workerName?: string }> = [];
    logger.subscribe((event) => {
      if (event.type === 'worker.process.stderr') {
        events.push({ line: event.line, workerName: event.workerName });
      }
    });

    const client = await spawnAcpProcess({
      command: process.execPath,
      args: ['-e', 'console.error("LOGGER_STDERR_LINE")'],
      workerName: 'implementer',
      onProcessStdioLine: ({ stream, line, workerName }) => {
        if (stream !== 'stderr') return;
        logger.emit({
          type: 'worker.process.stderr',
          line,
          stream: 'stderr',
          workerName,
        });
      },
    });

    await client.close();

    expect(events).toEqual([
      { line: 'LOGGER_STDERR_LINE', workerName: 'implementer' },
    ]);
  });
});
