import { expect, it } from 'vitest';
import { createOperatorDispatchQueue } from '../dispatch/operator-dispatch.js';
import { emptyOperatorRepositoryWatchState } from './operator-repository-watch-state.js';
import { createWatchRepositoryOperations } from './operator-watch-repository.js';
import { emptyWatchState } from './operator-watch-state.js';

it('reconciles the current states after both references are replaced', () => {
  let state = emptyWatchState();
  let repositoryState = emptyOperatorRepositoryWatchState();
  const oldState = state;
  const operations = createWatchRepositoryOperations({
    root: '/unused',
    options: { repoRoot: '/unused', dispatchQueue: createOperatorDispatchQueue() },
    get state() { return state; },
    get repositoryState() { return repositoryState; },
    onResumeStoreDuplicate: () => { },
  });

  state = emptyWatchState();
  repositoryState = emptyOperatorRepositoryWatchState();
  repositoryState.watches['example/repo'] = {
    githubRepo: 'example/repo',
    enabledAt: 1,
    lastScanAttemptAt: null,
    lastSuccessfulScanAt: null,
    lastScanError: null,
    scanIntervalMs: 30_000,
    pollIntervalMs: 10_000,
    debounceMs: 5,
    managedSessionIds: ['session'],
    manualSessionIds: [],
    suppressedSessionIds: [],
  };
  repositoryState.discoveries['example/repo'] = {
    session: { issueUrl: 'https://github.com/example/repo/issues/1', firstObservedAt: 1 },
  };

  operations.reconcileRepositoryAutoWatches();
  expect(state.watches.session).toMatchObject({ conductorAgentId: 'session', debounceMs: 5 });
  expect(oldState.watches).toEqual({});
});
