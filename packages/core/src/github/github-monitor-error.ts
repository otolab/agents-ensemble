import { isGitHubRateLimitError } from './github-auth.js';
import { GitHubApiError } from './github-client.js';
import { RunGhError } from './run-gh.js';

/** GitHub 監視 poll のフェーズ（`monitor_error` 用）。 */
export type GitHubMonitorErrorPhase =
  | 'issue_comments'
  | 'pr_search'
  | 'pr_reviews'
  | 'pr_review_comments'
  | 'pr_status_checks';

export type GitHubMonitorErrorCause =
  | 'parse'
  | 'gh_cli'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'unknown';

export interface GitHubMonitorPhaseError {
  phase: GitHubMonitorErrorPhase;
  prNumber?: number;
  cause: GitHubMonitorErrorCause;
  retryable: boolean;
  message: string;
  /** `formatGitHubErrorMessage` 用の元エラー。 */
  sourceError?: unknown;
}

/** poll フェーズ失敗を harness へ伝えるエラー。 */
export class GitHubMonitorError extends Error {
  readonly phase: GitHubMonitorErrorPhase;
  readonly prNumber?: number;
  readonly cause: GitHubMonitorErrorCause;
  readonly retryable: boolean;

  constructor(options: GitHubMonitorPhaseError) {
    super(options.message);
    this.name = 'GitHubMonitorError';
    this.phase = options.phase;
    this.prNumber = options.prNumber;
    this.cause = options.cause;
    this.retryable = options.retryable;
  }
}

export function safeUpperString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value.toUpperCase();
  }
  return fallback;
}

export function classifyGitHubMonitorError(
  error: unknown,
): Pick<GitHubMonitorPhaseError, 'cause' | 'retryable' | 'message'> {
  if (error instanceof GitHubMonitorError) {
    return {
      cause: error.cause,
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (error instanceof RunGhError) {
    return {
      cause:
        error.cause === 'auth'
          ? 'auth'
          : error.cause === 'rate_limit'
            ? 'rate_limit'
            : 'gh_cli',
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (error instanceof GitHubApiError) {
    if (isGitHubRateLimitError(error)) {
      return {
        cause: 'rate_limit',
        retryable: error.retryable,
        message: error.message,
      };
    }
    return {
      cause: error.status === 401 || error.status === 403 ? 'auth' : 'gh_cli',
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (isRetryableNetworkError(error)) {
    return {
      cause: 'network',
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (error instanceof TypeError) {
    return {
      cause: 'parse',
      retryable: false,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      cause: 'unknown',
      retryable: false,
      message: error.message,
    };
  }

  return {
    cause: 'unknown',
    retryable: false,
    message: String(error),
  };
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isRetryableNetworkError(
  error: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const candidate = error as {
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  if (
    typeof candidate.code === 'string' &&
    RETRYABLE_NETWORK_ERROR_CODES.has(candidate.code)
  ) {
    return true;
  }
  if (
    typeof candidate.message === 'string' &&
    /^(fetch failed|network error|network request failed|load failed)$/i.test(
      candidate.message.trim(),
    )
  ) {
    return true;
  }
  return isRetryableNetworkError(candidate.cause, seen);
}

export function createGitHubMonitorPhaseError(
  phase: GitHubMonitorErrorPhase,
  error: unknown,
  prNumber?: number,
): GitHubMonitorPhaseError {
  const classified = classifyGitHubMonitorError(error);
  return {
    phase,
    prNumber,
    ...classified,
    sourceError: error,
  };
}
