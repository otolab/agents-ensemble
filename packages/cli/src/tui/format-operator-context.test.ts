import { describe, expect, it } from 'vitest';
import {
  formatIssueLabel,
  formatIssueReference,
  formatOperatorContextHint,
  formatOsc8Link,
  supportsOsc8Hyperlinks,
} from './format-operator-context.js';

const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/249';

describe('formatOperatorContextHint', () => {
  it('returns default prompt when context is undefined', () => {
    expect(formatOperatorContextHint(undefined)).toBe('operator> ');
  });

  it('highlights open questions with selection context', () => {
    const hint = formatOperatorContextHint(
      {
        conductorTurn: 2,
        autonomousTurns: 1,
        maxTurns: 5,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Continue?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
          },
        ],
      },
      { id: 'inq-1', index: 0, total: 1 },
    );

    expect(hint).toContain('inq-1 (1/1)');
    expect(hint).toContain('Shift+↑↓で選択');
  });

  it('shows autonomous turn progress', () => {
    expect(
      formatOperatorContextHint({
        conductorTurn: 1,
        autonomousTurns: 2,
        maxTurns: null,
        openQuestions: [],
      }),
    ).toContain('2/∞');
  });

  it('prepends the current issue reference without changing the existing hint', () => {
    const hint = formatOperatorContextHint(
      {
        conductorTurn: 1,
        autonomousTurns: 2,
        maxTurns: null,
        openQuestions: [],
      },
      undefined,
      { issueUrl: ISSUE_URL, issueLinkMode: 'label' },
    );

    expect(hint).toBe(
      'otolab/agents-ensemble#249 — 自律ターン 2/∞ — 任意のタイミングで入力（/exit で終了）',
    );
  });

  it('keeps the issue reference when an open question is selected', () => {
    const hint = formatOperatorContextHint(
      {
        conductorTurn: 2,
        autonomousTurns: 1,
        maxTurns: 5,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Continue?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
          },
        ],
      },
      { id: 'inq-1', index: 0, total: 1 },
      { issueUrl: ISSUE_URL, issueLinkMode: 'label' },
    );

    expect(hint).toContain('otolab/agents-ensemble#249 — inq-1 (1/1)');
  });
});

describe('Issue reference formatting', () => {
  it('formats a compact issue label', () => {
    expect(formatIssueLabel(ISSUE_URL)).toBe('otolab/agents-ensemble#249');
  });

  it('wraps the issue label in an OSC 8 hyperlink', () => {
    expect(formatOsc8Link('otolab/agents-ensemble#249', ISSUE_URL)).toBe(
      `\u001b]8;;${ISSUE_URL}\u0007otolab/agents-ensemble#249\u001b]8;;\u0007`,
    );
    expect(formatIssueReference(ISSUE_URL, 'label')).toBe('otolab/agents-ensemble#249');
    expect(formatIssueReference(ISSUE_URL, 'url')).toBe(ISSUE_URL);
  });

  it('escapes OSC 8 control characters in the target URL', () => {
    expect(formatOsc8Link('issue', `${ISSUE_URL}\u0007\n`)).toContain(
      `${ISSUE_URL}%07%0A`,
    );
  });

  it('recognizes known OSC 8 terminals and rejects unsafe environments', () => {
    expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(supportsOsc8Hyperlinks({ WT_SESSION: '1' })).toBe(true);
    expect(supportsOsc8Hyperlinks({ TERM: 'dumb' })).toBe(false);
    expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: 'unknown' })).toBe(false);
  });
});
