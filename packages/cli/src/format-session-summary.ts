import type { SessionSummary } from '@agents-ensemble/core';

/** CLI 終了時 JSON（e2e / スクリプト向け SessionSummary）。 */
export function formatIssueSessionSummaryJson(summary: SessionSummary): string {
  return JSON.stringify(
    {
      agentId: summary.agentId,
      issueUrl: summary.issueUrl,
      repoRoot: summary.repoRoot,
      sendCount: summary.sendCount,
      stopReason: summary.stopReason,
      lastRunStatus: summary.lastRunStatus,
      lastResult: summary.lastResult,
      lastError: summary.lastError,
      workerDispatchCount: summary.workerDispatches.length,
      workerFailureCount: summary.workerFailures.length,
      escalationCount: summary.escalations.length,
      openQuestionCount: summary.openQuestions.length,
      workerResponses: summary.workerDispatches.map((dispatch) => ({
        name: dispatch.name,
        kind: dispatch.kind,
        responseText: dispatch.promptResult.responseText,
        stopReason: dispatch.promptResult.stopReason,
      })),
    },
    null,
    2,
  );
}
