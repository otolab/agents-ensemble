import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export const CLI_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../dist/index.js',
);

export async function runEnsembleCli(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeoutMs,
      },
    );

    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };

    if (typeof err.stdout === 'string') {
      return {
        stdout: err.stdout,
        stderr: err.stderr ?? '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }

    throw error;
  }
}

/** CLI stdout 末尾の JSON オブジェクトを取り出す（SDK ログ行が混ざる場合がある）。 */
export function parseCliJson<T>(stdout: string): T {
  const markers = [
    '{\n  "agentId"',
    '{\n  "issue"',
    '{\n  "stopReason"',
  ];

  let start = -1;
  for (const marker of markers) {
    const index = stdout.lastIndexOf(marker);
    if (index > start) start = index;
  }

  if (start === -1) {
    throw new Error(`No JSON object in CLI output:\n${stdout}`);
  }

  const end = stdout.lastIndexOf('}');
  if (end < start) {
    throw new Error(`Malformed JSON object in CLI output:\n${stdout}`);
  }

  return JSON.parse(stdout.slice(start, end + 1)) as T;
}
