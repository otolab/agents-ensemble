import { execFile, type ChildProcess } from 'node:child_process';

/**
 * @deprecated GitHub 情報取得には `GitHubClient` を使用する。
 * `resolveGitHubAuthToken` の `gh auth token` フォールバックのみが残存利用者。
 */
export interface RunGhOptions {
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * @deprecated GitHub 情報取得には `GitHubClient` を使用する。
 * `resolveGitHubAuthToken` の `gh auth token` フォールバックのみが残存利用者。
 */
export async function runGh(
  args: string[],
  options: RunGhOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    throw createRunGhAbortError();
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    const onAbort = () => {
      child.kill('SIGTERM');
      cleanup();
      reject(createRunGhAbortError());
    };
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    child = execFile(
      'gh',
      args,
      {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        cleanup();
        if (error) {
          const err = error as NodeJS.ErrnoException & { stderr?: string };
          const detail = err.stderr?.trim() || err.message;
          reject(new Error(`gh ${args.join(' ')} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );

    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createRunGhAbortError(): Error {
  const error = new Error('gh command aborted');
  error.name = 'AbortError';
  return error;
}
