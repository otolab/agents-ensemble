import { GitHubApiError } from './github-client.js';
import { RunGhError } from './run-gh.js';

/** GitHub 監視 poll のフェーズ（`monitor_error` 用）。 */
export type GitHubMonitorErrorPhase =
  | 'issue_comments'
  | 'pr_search'
  | 'pr_reviews'
  | 'pr_review_comments'
  | 'pr_status_checks';

export type GitHubMonitorErrorCause = 'parse' | 'gh_cli' | 'auth' | 'unknown';

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
      cause: error.cause === 'auth' ? 'auth' : 'gh_cli',
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (error instanceof GitHubApiError) {
    return {
      cause: error.status === 401 || error.status === 403 ? 'auth' : 'gh_cli',
      retryable: error.retryable,
      message: error.message,
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
