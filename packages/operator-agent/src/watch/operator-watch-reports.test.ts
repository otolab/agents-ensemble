import { describe, expect, it } from 'vitest';
import type { SessionObservationSnapshot, SessionResumeStore } from '@agents-ensemble/core/operator-runtime';
import { collectReports, cursorFor } from './operator-watch-reports.js';

const store = { issueUrl: 'https://github.com/example/repo/issues/1', conductorAgentId: 'session' } as SessionResumeStore;
const observation: SessionObservationSnapshot = {
  sequence: 2,
  openQuestions: [
    { id: 'inq-10', question: 'Tenth', responseType: 'text', source: 'conductor', status: 'open', askedAt: 1 },
    { id: 'inq-2', question: 'Second', responseType: 'text', source: 'conductor', status: 'open', askedAt: 2 },
  ],
  sessionState: { history: [{ statusLine: 'old', reportedAt: 10 }], current: { statusLine: 'new', reportedAt: 20 } },
};

describe('watch reports and cursors', () => {
  it('keeps first-poll status behavior and orders later questions before statuses', () => {
    const initial: SessionObservationSnapshot = { sequence: 1, openQuestions: [] };
    const previous = cursorFor(initial, 100, 'uds');
    const firstReports = collectReports(store, observation, undefined, 'uds');
    expect(firstReports).toHaveLength(1);
    expect(firstReports[0]!.text).toContain('new');
    const reports = collectReports(store, observation, previous, 'resume_store');
    expect(reports.map(({ reportType }) => reportType)).toEqual(['open_question', 'open_question', 'session_state', 'session_state']);
    expect(reports[0]!.text).toContain('inq-2');
    expect(reports[1]!.text).toContain('inq-10');
    const next = cursorFor(observation, 200, 'resume_store', previous);
    expect(next.questionCountObservation).toEqual({
      metric: 'unanswered_open_questions',
      current: { count: 2, checkedAt: 200, source: 'resume_store' },
      previous: { count: 0, checkedAt: 100, source: 'uds' },
    });
    expect(collectReports(store, observation, next, 'uds')).toEqual([]);
    expect(cursorFor(observation, undefined, undefined, next).questionCountObservation).toEqual(next.questionCountObservation);
  });

  it('reports a disappeared legacy question without inventing its prior status', () => {
    const reports = collectReports(store, { sequence: 2, openQuestions: [] }, {
      sequence: 1,
      questionFingerprints: { 'inq-1': 'legacy' },
      statusFingerprints: {},
    }, 'resume_store');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain('一覧から消失: inq-1');
    expect(reports[0]!.text).toContain('前回の status: 旧 cursor のため不明');
  });
});
