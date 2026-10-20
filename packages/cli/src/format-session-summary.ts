import type {
  SessionSummary,
  SessionUsageCacheStats,
} from '@agents-ensemble/core';

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
      startedAt: summary.startedAt,
      durationMs: summary.durationMs,
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function formatAgentUsage(
  label: string,
  inputTokens: number,
  outputTokens: number,
  cacheStats: SessionUsageCacheStats | null,
  estimated = false,
): string {
  const hasCache =
    cacheStats != null &&
    (cacheStats.cacheReadTokens != null ||
      cacheStats.cacheWriteTokens != null);
  const values = [
    `${hasCache ? '新規 input' : 'input'} ${formatTokenCount(inputTokens)}`,
    `output ${formatTokenCount(outputTokens)}`,
  ];

  if (hasCache && cacheStats?.cacheReadTokens != null) {
    values.push(`cache read ${formatTokenCount(cacheStats.cacheReadTokens)}`);
  }
  if (hasCache && cacheStats?.cacheWriteTokens != null) {
    values.push(`cache write ${formatTokenCount(cacheStats.cacheWriteTokens)}`);
  }
  if (hasCache && cacheStats?.cacheHitRate != null) {
    values.push(`hit ${formatPercent(cacheStats.cacheHitRate)}`);
  }
  if (estimated) {
    values.push('推定');
  }

  return `    ${label}: ${values.join(' · ')}`;
}

function formatElapsedTime(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}時間${minutes}分${seconds}秒`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

/** TTY 終了時の人間向けサマリ（1 画面程度）。 */
export function formatIssueSessionSummaryText(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`セッション終了 (${summary.stopReason})`);
  lines.push(`  経過時間: ${formatElapsedTime(summary.durationMs)}`);
  lines.push(`  conductor ターン: ${summary.sendCount}`);
  lines.push(
    `  worker ラウンド: ${summary.workerDispatches.length} 完了 / ${summary.workerFailures.length} 失敗`,
  );

  const usage = summary.sessionUsage;
  if (usage) {
    const tokenRows: string[] = [];
    const estimatedWorkers = new Set(
      summary.workerDispatches
        .filter((dispatch) => dispatch.promptResult.usage == null)
        .map((dispatch) => dispatch.name),
    );

    if (usage.byAgent.conductor.tokens) {
      const tokens = usage.byAgent.conductor.tokens;
      tokenRows.push(
        formatAgentUsage(
          'conductor',
          tokens.inputTokens,
          tokens.outputTokens,
          usage.cacheStats?.byAgent.conductor ?? null,
        ),
      );
    }
    for (const [name, agent] of Object.entries(usage.byAgent.workers)) {
      if (!agent.tokens) continue;
      tokenRows.push(
        formatAgentUsage(
          `worker ${name}`,
          agent.tokens.inputTokens,
          agent.tokens.outputTokens,
          usage.cacheStats?.byAgent.workers[name] ?? null,
          estimatedWorkers.has(name),
        ),
      );
    }
    if (usage.totals.tokens) {
      const tokens = usage.totals.tokens;
      tokenRows.push(
        `    合計: input ${formatTokenCount(tokens.inputTokens)} · output ${
          formatTokenCount(tokens.outputTokens)
        }`,
      );
    }
    if (tokenRows.length > 0) {
      lines.push('  usage（記録済み）:');
      lines.push(...tokenRows);
      lines.push(
        '    ※ 記録分のみ。失敗などで未記録の usage は含みません。',
      );
    }

    const context = usage.context;
    if (context.percent != null && context.limit != null) {
      lines.push(
        `  コンテキスト: ${context.percent}% (${context.limit.toLocaleString()} 上限)`,
      );
    }
  }

  const cost = usage?.cost;
  if (cost) {
    const costText = `${formatUsdFromCents(cost.chargedCents)} (raw ${formatUsdFromCents(cost.rawCostCents)})`;
    lines.push(
      `  課金（取得できた conductor 実課金。worker 分は未算出）: ${costText}`,
    );
  }

  if (usage?.compactionCount != null) {
    lines.push(`  コンテキスト圧縮: ${usage.compactionCount} 回`);
  }

  const openCount = summary.openQuestions.filter(
    (question) => question.status === 'open',
  ).length;
  lines.push(`  未回答 open question: ${openCount}`);
  lines.push(`  agentId: ${summary.agentId}`);

  return lines.join('\n');
}
