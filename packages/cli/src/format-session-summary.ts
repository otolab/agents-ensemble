import type { SessionSummary } from '@agents-ensemble/core';

export const DEFAULT_RESPONSE_PREVIEW_LENGTH = 240;

export interface FormatSessionSummaryOptions {
  /** JSON に worker 応答全文を載せる（既定は `responsePreview` のみ）。 */
  includeFullResponseText?: boolean;
  responsePreviewLength?: number;
}

export function truncateResponsePreview(
  text: string,
  maxLength: number = DEFAULT_RESPONSE_PREVIEW_LENGTH,
): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

/** CLI 終了時 JSON（e2e / スクリプト向け SessionSummary）。 */
export function formatIssueSessionSummaryJson(
  summary: SessionSummary,
  options: FormatSessionSummaryOptions = {},
): string {
  const previewLength =
    options.responsePreviewLength ?? DEFAULT_RESPONSE_PREVIEW_LENGTH;
  const includeFullResponseText = options.includeFullResponseText ?? false;

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
      ...(summary.sessionUsage ? { sessionUsage: summary.sessionUsage } : {}),
      workerResponses: summary.workerDispatches.map((dispatch) => {
        const responseText = dispatch.promptResult.responseText ?? '';
        const entry: Record<string, unknown> = {
          name: dispatch.name,
          kind: dispatch.kind,
          source: dispatch.source ?? 'conductor',
          stopReason: dispatch.promptResult.stopReason,
        };
        if (includeFullResponseText) {
          if (responseText) {
            entry.responseText = responseText;
          }
        } else if (responseText) {
          entry.responsePreview = truncateResponsePreview(
            responseText,
            previewLength,
          );
        }
        return entry;
      }),
    },
    null,
    2,
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

function formatUsdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** TTY 終了時の人間向けサマリ（1 画面程度）。 */
export function formatIssueSessionSummaryText(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`セッション終了 (${summary.stopReason})`);
  lines.push(`  conductor ターン: ${summary.sendCount}`);
  lines.push(
    `  worker ラウンド: ${summary.workerDispatches.length} 完了 / ${summary.workerFailures.length} 失敗`,
  );

  const tokens = summary.sessionUsage?.totals.tokens;
  if (tokens) {
    lines.push(
      `  トークン: input ${formatTokenCount(tokens.inputTokens)} / output ${formatTokenCount(tokens.outputTokens)}`,
    );
    const context = summary.sessionUsage?.context;
    if (context?.percent != null && context.limit != null) {
      lines.push(`  コンテキスト: ${context.percent}% (${context.limit.toLocaleString()} 上限)`);
    }
  }

  const cost = summary.sessionUsage?.cost;
  if (cost) {
    lines.push(
      `  課金: ${formatUsdFromCents(cost.chargedCents)} (raw ${formatUsdFromCents(cost.rawCostCents)})`,
    );
  }

  const openCount = summary.openQuestions.filter(
    (question) => question.status === 'open',
  ).length;
  lines.push(`  未回答 open question: ${openCount}`);
  lines.push(`  agentId: ${summary.agentId}`);

  return lines.join('\n');
}
