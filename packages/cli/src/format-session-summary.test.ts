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
  it('renders one-screen summary with tokens, cost, and open questions', () => {
    const text = formatIssueSessionSummaryText(createSummary());
    expect(text).toContain('セッション終了 (completed)');
    expect(text).toContain('conductor ターン: 3');
    expect(text).toContain('worker ラウンド: 1 完了 / 0 失敗');
    expect(text).toContain('トークン: input 1k / output 340');
    expect(text).toContain('課金: $0.42');
    expect(text).toContain('未回答 open question: 1');
    expect(text).toContain('agentId: agent-1');
  });
});

describe('truncateResponsePreview', () => {
  it('returns short text unchanged', () => {
    expect(truncateResponsePreview('ok', 10)).toBe('ok');
  });
});
