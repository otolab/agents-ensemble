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

function formatTokenUsage(inputTokens: number, outputTokens: number): string {
  return `input ${formatTokenCount(inputTokens)} / output ${formatTokenCount(outputTokens)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

/** TTY 終了時の人間向けサマリ（1 画面程度）。 */
export function formatIssueSessionSummaryText(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`セッション終了 (${summary.stopReason})`);
  lines.push(`  conductor ターン: ${summary.sendCount}`);
  lines.push(
    `  worker ラウンド: ${summary.workerDispatches.length} 完了 / ${summary.workerFailures.length} 失敗`,
  );

  const usage = summary.sessionUsage;
  if (usage) {
    const tokenRows: string[] = [];
    if (usage.totals.tokens) {
      tokenRows.push(
        `    全体: ${formatTokenUsage(
          usage.totals.tokens.inputTokens,
          usage.totals.tokens.outputTokens,
        )}`,
      );
    }
    if (usage.byAgent.conductor.tokens) {
      tokenRows.push(
        `    conductor: ${formatTokenUsage(
          usage.byAgent.conductor.tokens.inputTokens,
          usage.byAgent.conductor.tokens.outputTokens,
        )}`,
      );
    }
    for (const [name, agent] of Object.entries(usage.byAgent.workers)) {
      if (!agent.tokens) continue;
      tokenRows.push(
        `    worker ${name}: ${formatTokenUsage(
          agent.tokens.inputTokens,
          agent.tokens.outputTokens,
        )}`,
      );
    }
    if (tokenRows.length > 0) {
      lines.push('  トークン:');
      lines.push(...tokenRows);
      if (Object.keys(usage.byAgent.workers).length > 0) {
        lines.push(
          '    worker は ACP が usage を返さないラウンドで応答文からの推定値を含む場合があります。',
        );
      }
    }

    const cacheStats = usage.cacheStats;
    if (cacheStats) {
      const cacheScopes: Array<[string, SessionUsageCacheStats | null]> = [
        ['全体', cacheStats.totals],
        ['conductor', cacheStats.byAgent.conductor],
        ...Object.entries(cacheStats.byAgent.workers).map(([name, stats]) => [
          `worker ${name}`,
          stats,
        ] as [string, SessionUsageCacheStats | null]),
      ];
      const cacheRows = cacheScopes.flatMap(([label, stats]) => {
        if (!stats || stats.cacheHitRate == null) {
          return [];
        }
        const details = [
          stats.cacheReadTokens != null
            ? `read ${formatTokenCount(stats.cacheReadTokens)}`
            : undefined,
          stats.cacheWriteTokens != null
            ? `write ${formatTokenCount(stats.cacheWriteTokens)}`
            : undefined,
        ].filter((value) => value != null);
        return [
          `${label} ${formatPercent(stats.cacheHitRate)}${
            details.length > 0 ? ` (${details.join(', ')})` : ''
          }`,
        ];
      });
      if (cacheRows.length > 0) {
        lines.push(`  キャッシュヒット率: ${cacheRows.join(' / ')}`);
      }
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
    const workers = Object.keys(usage?.byAgent.workers ?? {});
    const costText = `${formatUsdFromCents(cost.chargedCents)} (raw ${formatUsdFromCents(cost.rawCostCents)})`;
    if (workers.length === 0) {
      lines.push(`  課金（全体 = conductor 実課金）: ${costText}`);
    } else {
      lines.push('  課金:');
      lines.push(`    conductor（実課金）: ${costText}`);
      lines.push('    workers 小計: 算出なし（ACP が cost を返さないため）');
      lines.push(
        `    全体: ${costText}（conductor 実課金のみ。worker 分は未算出）`,
      );
    }
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
