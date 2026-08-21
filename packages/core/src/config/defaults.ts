import {
  DEFAULT_GITHUB_MONITOR_ACTIVE_POLL_INTERVAL_MS,
  DEFAULT_GITHUB_MONITOR_DEBOUNCE_MS,
  DEFAULT_GITHUB_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_GITHUB_MONITOR_STOP_POLL_WAIT_MS,
} from '../github/github-monitor.js';
import type { EnsembleConfig } from './types.js';

/** `packages/cli` の `NON_INTERACTIVE_DEFAULT_MAX_TURNS` と同期。 */
export const DEFAULT_SESSION_MAX_TURNS_NON_TTY = 5;

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  profile: {},
  conductor: {
    model: 'default',
  },
  acp: {
    defaultPreset: 'cursor',
  },
  session: {
    worktree: 'isolated',
    maxTurns: {
      tty: 0,
      nonTty: DEFAULT_SESSION_MAX_TURNS_NON_TTY,
    },
    postLoop: {
      wait: true,
    },
  },
  github: {
    auth: {
      allowGhAuthTokenFallback: true,
    },
    monitor: {
      enabled: true,
      debounceMs: DEFAULT_GITHUB_MONITOR_DEBOUNCE_MS,
      pollIntervalMs: DEFAULT_GITHUB_MONITOR_POLL_INTERVAL_MS,
      activePollIntervalMs: DEFAULT_GITHUB_MONITOR_ACTIVE_POLL_INTERVAL_MS,
      stopPollWaitMs: DEFAULT_GITHUB_MONITOR_STOP_POLL_WAIT_MS,
    },
  },
};
