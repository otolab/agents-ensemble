import { execFile, type ChildProcess } from 'node:child_process';

export interface RunGhOptions {
  cwd?: string;
  signal?: AbortSignal;
}

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
