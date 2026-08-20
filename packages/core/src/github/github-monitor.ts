import type { EnsembleConfig } from '../config/types.js';
import { DebounceBuffer } from './debounce-buffer.js';
import {
  fetchGitHubUpdates,
  type FetchGitHubUpdatesInput,
} from './fetch-github-updates.js';
import { formatGitHubErrorMessage } from './github-auth.js';
import { GitHubMonitorError } from './github-monitor-error.js';
import type { GitHubClient } from './github-client.js';
import {
  emptyGitHubMonitorCursor,
  isEmptyGitHubMonitorCursor,
  normalizeGitHubMonitorCursor,
  type GitHubMonitorCursor,
} from './github-monitor-cursor.js';
import type { GitHubUpdateItem, GitHubUpdatePayload } from './github-update-types.js';

export const DEFAULT_GITHUB_MONITOR_DEBOUNCE_MS = 30_000;
export const DEFAULT_GITHUB_MONITOR_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_GITHUB_MONITOR_ACTIVE_POLL_INTERVAL_MS = 15_000;
/** `stop()` が進行中 poll の完了を待つ上限（ms）。超過時は poll を abort する（#209）。 */
export const DEFAULT_GITHUB_MONITOR_STOP_POLL_WAIT_MS = 5_000;

export interface GitHubMonitorOptions {
  issueUrl: string;
  /** harness 設定。GitHub API 認証解決で参照する。 */
  ensembleConfig: EnsembleConfig;
  cursor?: GitHubMonitorCursor;
  debounceMs?: number;
  pollIntervalMs?: number;
  activePollIntervalMs?: number;
  /** `stop()` が `pollInFlight` を待つ上限（ms）。デフォルト 5s。 */
  stopPollWaitMs?: number;
  onUpdate: (payload: GitHubUpdatePayload) => void;
  onCursorChange?: (cursor: GitHubMonitorCursor) => void;
  onPollError?: (error: unknown) => void;
  shutdownSignal?: AbortSignal;
  githubClient?: GitHubClient;
}

export interface GitHubMonitor {
  start(): void;
  stop(): Promise<void>;
  flush(): void;
  getCursor(): GitHubMonitorCursor;
}

export function createGitHubMonitor(options: GitHubMonitorOptions): GitHubMonitor {
  const debounceMs = options.debounceMs ?? DEFAULT_GITHUB_MONITOR_DEBOUNCE_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_GITHUB_MONITOR_POLL_INTERVAL_MS;
  const activePollIntervalMs =
    options.activePollIntervalMs ?? DEFAULT_GITHUB_MONITOR_ACTIVE_POLL_INTERVAL_MS;
  const stopPollWaitMs =
    options.stopPollWaitMs ?? DEFAULT_GITHUB_MONITOR_STOP_POLL_WAIT_MS;

  let cursor = normalizeGitHubMonitorCursor(
    options.cursor ?? emptyGitHubMonitorCursor(),
  );
  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollInFlight = false;
  let pollAbortController: AbortController | undefined;
  let hasPendingCi = false;
  let needsBootstrapPoll = isEmptyGitHubMonitorCursor(cursor);

  const buffer = new DebounceBuffer<GitHubUpdateItem>({
    debounceMs,
    shutdownSignal: options.shutdownSignal,
    onFlush: (items) => {
      if (items.length === 0) return;
      options.onUpdate({ items });
    },
  });

  const schedulePoll = (delayMs: number) => {
    if (stopped || !started) return;
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
    }
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void pollOnce();
    }, delayMs);
  };

  const pollOnce = async (): Promise<void> => {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    pollAbortController = new AbortController();
    try {
      const input: FetchGitHubUpdatesInput = {
        issueUrl: options.issueUrl,
        cursor,
        ensembleConfig: options.ensembleConfig,
        githubClient: options.githubClient,
        initialCursorPoll: needsBootstrapPoll,
        abortSignal: pollAbortController.signal,
      };
      const result = await fetchGitHubUpdates(input);
      cursor = result.cursor;
      options.onCursorChange?.(cursor);
      needsBootstrapPoll = false;
      hasPendingCi = result.hasPendingCi;
      if (result.updates.length > 0) {
        buffer.pushMany(result.updates);
      }
      for (const phaseError of result.errors) {
        const source = phaseError.sourceError ?? new Error(phaseError.message);
        options.onPollError?.(
          new GitHubMonitorError({
            phase: phaseError.phase,
            prNumber: phaseError.prNumber,
            cause: phaseError.cause,
            retryable: phaseError.retryable,
            message: formatGitHubErrorMessage(source, options.ensembleConfig),
          }),
        );
      }
    } catch (error) {
      if (!isAbortError(error)) {
        options.onPollError?.(
          new Error(formatGitHubErrorMessage(error, options.ensembleConfig)),
        );
      }
    } finally {
      pollAbortController = undefined;
      pollInFlight = false;
      if (!stopped && started) {
        const nextDelay = hasPendingCi ? activePollIntervalMs : pollIntervalMs;
        schedulePoll(nextDelay);
      }
    }
  };

  const abortInFlightPoll = () => {
    pollAbortController?.abort();
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void pollOnce();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      buffer.stop();
      const deadline = Date.now() + stopPollWaitMs;
      while (pollInFlight) {
        if (Date.now() >= deadline) {
          abortInFlightPoll();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (pollInFlight) {
        const graceDeadline = Date.now() + 500;
        while (pollInFlight && Date.now() < graceDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    },

    flush() {
      buffer.flush();
    },

    getCursor() {
      return normalizeGitHubMonitorCursor(cursor);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
