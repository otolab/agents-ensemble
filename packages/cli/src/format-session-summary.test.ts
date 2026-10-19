import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@agents-ensemble/core';
import {
  DEFAULT_RESPONSE_PREVIEW_LENGTH,
  formatIssueSessionSummaryJson,
  formatIssueSessionSummaryText,
  truncateResponsePreview,
} from './format-session-summary.js';

function createSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    agentId: 'agent-1',
    issueUrl: 'https://github.com/org/repo/issues/1',
    repoRoot: '/repo',
    sendCount: 3,
    stopReason: 'completed',
    lastRunStatus: 'finished',
    workerDispatches: [
      {
        name: 'implementer',
        kind: 'implementer',
        source: 'conductor',
        issue: { owner: 'org', repo: 'repo', number: 1, url: 'https://github.com/org/repo/issues/1' },
        worktree: {
          path: '/repo/.ensemble/worktrees/issue-1',
          branch: 'ensemble/issue-1',
          issue: { owner: 'org', repo: 'repo', number: 1, url: 'https://github.com/org/repo/issues/1' },
        },
        prompt: 'do work',
        promptResult: {
          stopReason: 'end_turn',
          responseText: 'hello world response',
        },
        acpSessionId: 'acp-1',
      },
    ],
    workerFailures: [],
    escalations: [],
    openQuestions: [
      {
        id: 'q-1',
        question: 'approve?',
        responseType: 'yes_no',
        source: 'conductor',
        status: 'open',
        askedAt: 1,
      },
    ],
    sessionUsage: {
      totals: {
        rounds: 2,
        roundsWithUsage: 2,
        tokens: {
          inputTokens: 1200,
          outputTokens: 340,
          totalTokens: 1540,
        },
      },
      byAgent: {
        conductor: { rounds: 1, roundsWithUsage: 1, tokens: { inputTokens: 1000, outputTokens: 300, totalTokens: 1300 } },
        workers: {},
      },
      context: { limit: 100_000, usedInputTokens: 1200, percent: 1 },
      latestRound: null,
      cost: { rawCostCents: 51, chargedCents: 42 },
    },
    ...overrides,
  };
}

describe('formatIssueSessionSummaryJson', () => {
  it('includes sessionUsage and responsePreview by default', () => {
    const json = JSON.parse(formatIssueSessionSummaryJson(createSummary()));
    expect(json.sessionUsage?.totals.tokens.inputTokens).toBe(1200);
    expect(json.workerResponses[0]).toMatchObject({
      name: 'implementer',
      responsePreview: 'hello world response',
    });
    expect(json.workerResponses[0].responseText).toBeUndefined();
  });

  it('omits conductor cost from exit JSON when billing data is unavailable', () => {
    const { cost: _cost, ...sessionUsage } = createSummary().sessionUsage!;
    const json = JSON.parse(
      formatIssueSessionSummaryJson(createSummary({ sessionUsage })),
    );

    expect(json.sessionUsage.cost).toBeUndefined();
  });

  it('keeps cache and compaction metrics identical in the exit JSON', () => {
    const sessionUsage = {
      ...createSummary().sessionUsage!,
      cacheStats: {
        totals: { cacheHitRate: 0.5, cacheReadTokens: 50 },
        byAgent: { conductor: { cacheHitRate: 0.5, cacheReadTokens: 50 }, workers: {} },
      },
      compactionCount: 1,
    };
    const json = JSON.parse(
      formatIssueSessionSummaryJson(createSummary({ sessionUsage })),
    );

    expect(json.sessionUsage).toEqual(sessionUsage);
    expect(json.sessionUsage.costByAgent).toBeUndefined();
  });

  it('truncates long responses in preview', () => {
    const longText = 'x'.repeat(DEFAULT_RESPONSE_PREVIEW_LENGTH + 10);
    const json = JSON.parse(
      formatIssueSessionSummaryJson(
        createSummary({
          workerDispatches: [
            {
              ...createSummary().workerDispatches[0]!,
              promptResult: { stopReason: 'end_turn', responseText: longText },
            },
          ],
        }),
      ),
    );
    expect(json.workerResponses[0].responsePreview).toHaveLength(
      DEFAULT_RESPONSE_PREVIEW_LENGTH + 1,
    );
    expect(json.workerResponses[0].responsePreview.endsWith('…')).toBe(true);
  });

  it('includes full responseText when opted in', () => {
    const json = JSON.parse(
      formatIssueSessionSummaryJson(createSummary(), {
        includeFullResponseText: true,
      }),
    );
    expect(json.workerResponses[0].responseText).toBe('hello world response');
    expect(json.workerResponses[0].responsePreview).toBeUndefined();
  });
});

describe('formatIssueSessionSummaryText', () => {
  it('renders total and conductor token rows with conductor actual cost', () => {
    const text = formatIssueSessionSummaryText(createSummary());
    expect(text).toContain('セッション終了 (completed)');
    expect(text).toContain('conductor ターン: 3');
    expect(text).toContain('worker ラウンド: 1 完了 / 0 失敗');
    expect(text).toContain('全体: input 1k / output 340');
    expect(text).toContain('conductor: input 1k / output 300');
    expect(text).toContain('課金（全体 = conductor 実課金）: $0.42 (raw $0.51)');
    expect(text).toContain('未回答 open question: 1');
    expect(text).toContain('agentId: agent-1');
  });

  it('renders multiple workers, available cache rates, cost scope, and compaction count', () => {
    const base = createSummary();
    const dispatch = base.workerDispatches[0]!;
    const text = formatIssueSessionSummaryText(
      createSummary({
        workerDispatches: [
          dispatch,
          {
            ...dispatch,
            name: 'reviewer',
            kind: 'reviewer',
          },
        ],
        sessionUsage: {
          ...base.sessionUsage!,
          totals: {
            ...base.sessionUsage!.totals,
            tokens: {
              inputTokens: 2840,
              outputTokens: 920,
              totalTokens: 3760,
            },
          },
          byAgent: {
            conductor: {
              rounds: 1,
              roundsWithUsage: 1,
              tokens: {
                inputTokens: 2040,
                outputTokens: 600,
                totalTokens: 2640,
              },
            },
            workers: {
              implementer: {
                rounds: 2,
                roundsWithUsage: 2,
                tokens: {
                  inputTokens: 500,
                  outputTokens: 120,
                  totalTokens: 620,
                },
              },
              reviewer: {
                rounds: 1,
                roundsWithUsage: 1,
                tokens: {
                  inputTokens: 300,
                  outputTokens: 200,
                  totalTokens: 500,
                },
              },
            },
          },
          cacheStats: {
            totals: {
              cacheHitRate: 500 / 2300,
              cacheReadTokens: 500,
              cacheWriteTokens: 20,
            },
            byAgent: {
              conductor: {
                cacheHitRate: 0.2,
                cacheReadTokens: 400,
                cacheWriteTokens: 20,
              },
              workers: {
                implementer: {
                  cacheHitRate: 1 / 3,
                  cacheReadTokens: 100,
                  cacheWriteTokens: 0,
                },
                reviewer: null,
              },
            },
          },
          compactionCount: 2,
        },
      }),
    );

    expect(text).toContain('worker ラウンド: 2 完了 / 0 失敗');
    expect(text).toContain('全体: input 3k / output 920');
    expect(text).toContain('conductor: input 2k / output 600');
    expect(text).toContain('worker implementer: input 500 / output 120');
    expect(text).toContain('worker reviewer: input 300 / output 200');
    expect(text).toContain(
      'キャッシュヒット率: 全体 21.7% (read 500, write 20) / conductor 20% (read 400, write 20) / worker implementer 33.3% (read 100, write 0)',
    );
    expect(text).toContain('workers 小計: 算出なし（ACP が cost を返さないため）');
    expect(text).toContain(
      '全体: $0.42 (raw $0.51)（conductor 実課金のみ。worker 分は未算出）',
    );
    expect(text).toContain('コンテキスト圧縮: 2 回');
  });

  it('omits cost, cache rate, and compaction when unavailable', () => {
    const { cost: _cost, ...sessionUsage } = createSummary().sessionUsage!;
    const text = formatIssueSessionSummaryText(
      createSummary({
        sessionUsage: {
          ...sessionUsage,
          cacheStats: {
            totals: { cacheReadTokens: 0 },
            byAgent: { conductor: { cacheReadTokens: 0 }, workers: {} },
          },
        },
      }),
    );

    expect(text).not.toContain('課金');
    expect(text).not.toContain('キャッシュヒット率');
    expect(text).not.toContain('コンテキスト圧縮');
  });
});

describe('truncateResponsePreview', () => {
  it('returns short text unchanged', () => {
    expect(truncateResponsePreview('ok', 10)).toBe('ok');
  });
});
