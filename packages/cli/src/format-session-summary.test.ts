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
    startedAt: 1_750_000_000_000,
    durationMs: 83_000,
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
      tokenScope: 'recorded-usage-only',
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
      cost: {
        rawCostCents: 51,
        chargedCents: 42,
        scope: 'conductor-only',
      },
    },
    ...overrides,
  };
}

describe('formatIssueSessionSummaryJson', () => {
  it('includes sessionUsage and responsePreview by default', () => {
    const json = JSON.parse(formatIssueSessionSummaryJson(createSummary()));
    expect(json.startedAt).toBe(1_750_000_000_000);
    expect(json.durationMs).toBe(83_000);
    expect(json.sessionUsage?.totals.tokens.inputTokens).toBe(1200);
    expect(json.sessionUsage?.tokenScope).toBe('recorded-usage-only');
    expect(json.sessionUsage?.latestRound).toBeNull();
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
    expect(json.sessionUsage.cost.scope).toBe('conductor-only');
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
  it('renders recorded total and conductor token rows with conductor actual cost', () => {
    const text = formatIssueSessionSummaryText(createSummary());
    expect(text).toContain('セッション終了 (completed)');
    expect(text).toContain('経過時間: 1分23秒');
    expect(text).toContain('conductor ターン: 3');
    expect(text).toContain('worker ラウンド: 1 完了 / 0 失敗');
    expect(text).toContain('usage（記録済み）:');
    expect(text).toContain('conductor: input 1k · output 300');
    expect(text).toContain('合計: input 1k · output 340');
    expect(text).toContain(
      '課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)',
    );
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
            promptResult: {
              ...dispatch.promptResult,
              usage: {
                inputTokens: 300,
                outputTokens: 200,
                totalTokens: 500,
              },
            },
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
    expect(text).toContain(
      'conductor: 新規 input 2k · output 600 · cache read 400 · cache write 20 · hit 20%',
    );
    expect(text).toContain(
      'worker implementer: 新規 input 500 · output 120 · cache read 100 · cache write 0 · hit 33.3% · 推定',
    );
    expect(text).toContain('worker reviewer: input 300 · output 200');
    expect(text).toContain('合計: input 3k · output 920');
    expect(text).toContain(
      '※ 記録分のみ。失敗などで未記録の usage は含みません。',
    );
    expect(text).not.toContain('21.7%');
    expect(text).not.toContain('worker は ACP が usage を返さない');
    expect(text).not.toContain('キャッシュヒット率:');
    expect(text).toContain(
      '課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)',
    );
    expect(text).toContain('コンテキスト圧縮: 2 回');
  });

  it('keeps compaction on its own line when token usage rows are absent', () => {
    const base = createSummary();
    const { cost: _cost, ...sessionUsage } = base.sessionUsage!;
    const text = formatIssueSessionSummaryText(
      createSummary({
        workerDispatches: [],
        sessionUsage: {
          ...sessionUsage,
          totals: {
            ...sessionUsage.totals,
            rounds: 0,
            roundsWithUsage: 0,
            tokens: null,
          },
          byAgent: {
            conductor: { rounds: 0, roundsWithUsage: 0, tokens: null },
            workers: {},
          },
          context: { limit: null, usedInputTokens: 0, percent: null },
          compactionCount: 2,
        },
      }),
    );

    expect(text).toContain('コンテキスト圧縮: 2 回');
    expect(text).not.toContain('usage（記録済み）:');
    expect(text).not.toContain('※ 記録分のみ。');
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

  it('does not present conductor cost as the session total when a worker failed without usage', () => {
    const base = createSummary();
    const summary = createSummary({
      workerDispatches: [],
      workerFailures: [
        {
          workerId: 'worker-implementer',
          name: 'implementer',
          kind: 'implementer',
          issueUrl: 'https://github.com/org/repo/issues/1',
          error: 'ACP disconnected after the prompt started',
        },
      ],
      sessionUsage: {
        ...base.sessionUsage!,
        byAgent: {
          ...base.sessionUsage!.byAgent,
          workers: {},
        },
      },
    });
    const text = formatIssueSessionSummaryText(summary);
    const json = JSON.parse(formatIssueSessionSummaryJson(summary));

    expect(text).toContain('worker ラウンド: 0 完了 / 1 失敗');
    expect(text).toContain('合計: input 1k · output 340');
    expect(text).not.toContain('失敗などで usage が未記録');
    expect(text).not.toContain('全体: input 1k / output 340');
    expect(text).toContain(
      '課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)',
    );
    expect(text).not.toContain('全体 = conductor');
    expect(text).not.toContain('全体: $0.42');
    expect(json.workerFailureCount).toBe(1);
    expect(json.sessionUsage.tokenScope).toBe('recorded-usage-only');
    expect(json.sessionUsage.cost.scope).toBe('conductor-only');
    expect(json.sessionUsage.totals.tokens.inputTokens).toBe(1200);
    expect(json.sessionUsage.byAgent.workers).toEqual({});
  });
});

describe('truncateResponsePreview', () => {
  it('returns short text unchanged', () => {
    expect(truncateResponsePreview('ok', 10)).toBe('ok');
  });
});
