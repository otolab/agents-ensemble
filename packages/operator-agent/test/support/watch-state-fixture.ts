import type { OperatorWatchState } from '../../src/watch/operator-watch-state.js';

type PendingReport = OperatorWatchState['pendingReports'][number];

/** Build a valid Open Question report without filling in its timing or identity. */
export function openQuestionReport(
  fields: Omit<PendingReport, 'reportType' | 'priority'>,
): PendingReport {
  return { ...fields, reportType: 'open_question', priority: 'open_question' };
}
