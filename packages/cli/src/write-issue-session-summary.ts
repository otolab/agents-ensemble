import type { ConductorSessionResult } from '@agents-ensemble/core';
import {
  formatIssueSessionSummaryJson,
  formatIssueSessionSummaryText,
  type FormatSessionSummaryOptions,
} from './format-session-summary.js';
import type { ResolvedIssueSummaryFormat } from './resolve-summary-format.js';

export function writeIssueSessionSummary(
  summary: ConductorSessionResult,
  input: {
    format: ResolvedIssueSummaryFormat;
    jsonOptions?: FormatSessionSummaryOptions;
  },
): void {
  if (input.format === 'json') {
    console.log(
      formatIssueSessionSummaryJson(summary, input.jsonOptions ?? {}),
    );
    return;
  }

  console.error(formatIssueSessionSummaryText(summary));
}
