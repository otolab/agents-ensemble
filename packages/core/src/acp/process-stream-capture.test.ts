import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { attachChildProcessStderrCapture } from './process-stream-capture.js';

describe('attachChildProcessStderrCapture', () => {
  it('captures stderr from a fast-exiting child', async () => {
    const captured: string[] = [];
    const child = spawn(process.execPath, [
      '-e',
      'console.error("CAPTURE_LINE")',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const { drainStderr } = attachChildProcessStderrCapture(child.stderr!, {
      onLine: ({ line }) => captured.push(line),
    });

    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await drainStderr();

    expect(captured).toContain('CAPTURE_LINE');
  });
});
