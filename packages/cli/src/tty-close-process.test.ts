import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('TTY /close process lifecycle', () => {
  it('exits naturally after the CLI closes the TUI and conductor session', async () => {
    const fixturePath = fileURLToPath(
      new URL('../test/process-fixtures/tty-close-process.mjs', import.meta.url),
    );
    const childResult = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [fixturePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new Error('TTY /close child process did not exit within 10 seconds'),
        );
      }, 10_000);

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        if (!settled) reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        resolve({ code, signal, stdout, stderr });
      });
    });

    expect(childResult.code, childResult.stderr).toBe(0);
    expect(childResult.signal).toBeNull();
    expect(childResult.stdout).toContain('close-process-session-completed');
  });
});
