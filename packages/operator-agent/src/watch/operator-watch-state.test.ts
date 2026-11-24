import { describe, expect, it } from 'vitest';
import { openQuestionReport } from '../../test/support/watch-state-fixture.js';
import {
  emptyWatchState,
  extractWatchStateForSession,
  mergeWatchStates,
  partitionWatchState,
  removeWatchStateForSession,
  watchStateSessionIds,
  type OperatorWatchState,
} from './operator-watch-state.js';

const report = (reportId: string, conductorAgentId: string, readyAt: number): OperatorWatchState['pendingReports'][number] => openQuestionReport({
  reportId, conductorAgentId, readyAt,
  issueUrl: 'https://github.com/example/repo/issues/1',
  text: reportId, debounceMs: 5, arrivalOrder: readyAt, firstQueuedAt: 1,
});

describe('watch state transformations', () => {
  it('keeps fallback insertion order while preferred wins duplicate report IDs', () => {
    const fallback = emptyWatchState();
    fallback.pendingReports = [report('a', 'one', 10), report('b', 'one', 20)];
    fallback.messageCursors.one = 1;
    const preferred = emptyWatchState();
    preferred.pendingReports = [report('b', 'one', 30), report('c', 'two', 40)];
    preferred.messageCursors.one = 0;
    const merged = mergeWatchStates(preferred, fallback);
    expect(merged.pendingReports.map(({ reportId, readyAt }) => [reportId, readyAt])).toEqual([
      ['a', 10], ['b', 30], ['c', 40],
    ]);
    expect(merged.messageCursors.one).toBe(0);
    expect(fallback.pendingReports[1]!.readyAt).toBe(20);
  });

  it('partitions in order, verifies issue identity and mutates only the removed session', () => {
    const state = emptyWatchState();
    state.messageCursors = { one: 0, two: 2 };
    state.pendingReports = [report('a', 'one', 10), report('b', 'two', 20), report('c', 'one', 30)];
    const paths = new Map([['one', 'path-one'], ['two', 'path-two']]);
    const issues = new Map([['one', 'https://github.com/EXAMPLE/repo/issues/1'], ['two', 'https://github.com/example/repo/issues/1']]);
    const partitions = partitionWatchState(state, paths, issues);
    expect(partitions.get('path-one')!.pendingReports.map(({ reportId, readyAt }) => [reportId, readyAt])).toEqual([['a', 10], ['c', 30]]);
    expect(extractWatchStateForSession(state, 'one').messageCursors.one).toBe(0);
    expect(() => partitionWatchState(state, paths, new Map([['one', 'https://github.com/example/repo/issues/2'], ['two', issues.get('two')!]]))).toThrow(/no longer matches/);
    expect(() => partitionWatchState(state, new Map(), issues)).toThrow(/lost its Issue session mapping/);
    removeWatchStateForSession(state, 'one');
    expect([...watchStateSessionIds(state)]).toEqual(['two']);
    expect(state.pendingReports.map(({ reportId }) => reportId)).toEqual(['b']);
    expect(state.messageCursors).toEqual({ two: 2 });
  });
});
