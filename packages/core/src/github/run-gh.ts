import { execFile, type ChildProcess } from 'node:child_process';

/**
 * @deprecated GitHub 情報取得には `GitHubClient` を使用する。
 * `resolveGitHubAuthToken` の `gh auth token` フォールバックのみが残存利用者。
 */
export interface RunGhOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export type RunGhErrorCause = 'auth' | 'rate_limit' | 'repo_access' | 'unknown';

/** `gh` CLI 実行失敗。認証・rate limit 等を分類する。 */
export class RunGhError extends Error {
  readonly retryable: boolean;
  readonly cause: RunGhErrorCause;

  constructor(
    message: string,
    options: { retryable: boolean; cause: RunGhErrorCause },
  ) {
    super(message);
    this.name = 'RunGhError';
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
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
      (error, stdout, stderr) => {
        cleanup();
        if (error) {
          const detail = (typeof stderr === 'string' ? stderr.trim() : '') || error.message;
          reject(classifyRunGhFailure(args, detail));
          return;
        }
        resolve(stdout);
      },
    );

    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** @internal テスト用に export。 */
export function classifyRunGhFailure(args: string[], detail: string): RunGhError {
  const command = `gh ${args.join(' ')}`;
  const lower = detail.toLowerCase();

  if (
    /not logged in|authentication required|401|bad credentials|gh auth login|to authenticate/i.test(
      lower,
    )
  ) {
    return new RunGhError(
      `${command} failed: ${detail}\n\n` +
        'GitHub CLI 認証が必要です。`gh auth login` を実行するか、`export GITHUB_TOKEN=...` を設定してください。',
      { cause: 'auth', retryable: false },
    );
  }

  if (/rate limit|429|secondary rate limit|abuse detection/i.test(lower)) {
    return new RunGhError(
      `${command} failed: ${detail}（rate limit — しばらく待ってから再試行してください）`,
      { cause: 'rate_limit', retryable: true },
    );
  }

  if (
    /could not resolve|not found|404|does not have|repository.*not|no such repository/i.test(
      lower,
    )
  ) {
    return new RunGhError(
      `${command} failed: ${detail}\n\n` +
        'リポジトリアクセスを確認してください（issue URL と作業ディレクトリの origin が一致しているか）。',
      { cause: 'repo_access', retryable: false },
    );
  }

  return new RunGhError(`${command} failed: ${detail}`, {
    cause: 'unknown',
    retryable: false,
  });
}

function createRunGhAbortError(): Error {
  const error = new Error('gh command aborted');
  error.name = 'AbortError';
  return error;
}
