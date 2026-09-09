import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '@agents-ensemble/core';
import {
  formatIssueLabel,
  formatIssueReference,
  formatOperatorContextHint,
  formatOsc8Link,
  resolveOperatorInputDisplayMode,
  supportsOsc8Hyperlinks,
} from './format-operator-context.js';
import {
  OPERATOR_INPUT_DISCRETIONARY_HINT,
  OPERATOR_INPUT_POST_LOOP_HINT,
  OPERATOR_INPUT_SHUTTING_DOWN_HINT,
} from './tui-layout-constants.js';

const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/249';
const NON_CANONICAL_ISSUE_URL = 'http://github.com/otolab/agents-ensemble/issues/249/';
const OPEN_QUESTION: OpenQuestion = {
  id: 'inq-1',
  question: 'Continue?',
  responseType: 'text',
  source: 'conductor',
  status: 'open',
  askedAt: 1,
};

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

  it('shows the discretionary no-question prompt without autonomous turn progress', () => {
    expect(
      formatOperatorContextHint({
        conductorTurn: 1,
        autonomousTurns: 2,
        maxTurns: null,
        openQuestions: [],
      }),
    ).toBe(OPERATOR_INPUT_DISCRETIONARY_HINT);
  });

  it('does not prepend the issue reference to operator input prompts', () => {
    const hint = formatOperatorContextHint(
      {
        conductorTurn: 1,
        autonomousTurns: 2,
        maxTurns: null,
        openQuestions: [],
      },
      undefined,
    );

    expect(hint).toBe(OPERATOR_INPUT_DISCRETIONARY_HINT);
  });

  it('does not add the issue reference when an open question is selected', () => {
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

    expect(hint).toBe('inq-1 (1/1) への回答 — Shift+↑↓で選択 · Enter で送信');
  });
});

describe('resolveOperatorInputDisplayMode', () => {
  it('resolves the two display modes from open-question presence', () => {
    const withQuestions = resolveOperatorInputDisplayMode({
      openQuestions: [OPEN_QUESTION],
    });
    const noQuestions = resolveOperatorInputDisplayMode({ openQuestions: [] });

    expect(withQuestions).toEqual({
      mode: 'withQuestions',
      hintLines: ['open question あり — Shift+↑↓で選択して回答'],
    });
    expect(noQuestions).toEqual({
      mode: 'noQuestions',
      hintLines: [OPERATOR_INPUT_DISCRETIONARY_HINT],
    });
  });

  it('overrides the no-question prompt during post-loop wait', () => {
    expect(
      resolveOperatorInputDisplayMode({
        openQuestions: [],
        postLoopWaiting: true,
      }),
    ).toEqual({
      mode: 'noQuestions',
      hintLines: [OPERATOR_INPUT_POST_LOOP_HINT],
    });
  });

  it('keeps shutdown as the highest-priority prompt override', () => {
    expect(
      resolveOperatorInputDisplayMode({
        openQuestions: [],
        postLoopWaiting: true,
        shuttingDown: true,
      }),
    ).toEqual({
      mode: 'noQuestions',
      hintLines: [OPERATOR_INPUT_SHUTTING_DOWN_HINT],
    });
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

  it('normalizes OSC 8 and URL targets to the canonical GitHub Issue URL', () => {
    const canonicalOsc8Open = `\u001b]8;;${ISSUE_URL}\u0007`;

    expect(formatOsc8Link('otolab/agents-ensemble#249', NON_CANONICAL_ISSUE_URL)).toContain(
      canonicalOsc8Open,
    );
    expect(formatOsc8Link('otolab/agents-ensemble#249', NON_CANONICAL_ISSUE_URL)).not.toContain(
      `\u001b]8;;${NON_CANONICAL_ISSUE_URL}\u0007`,
    );
    expect(formatIssueReference(NON_CANONICAL_ISSUE_URL, 'osc8')).toContain(canonicalOsc8Open);
    expect(formatIssueReference(NON_CANONICAL_ISSUE_URL, 'url')).toBe(ISSUE_URL);
  });

  it('escapes OSC 8 control characters in the target URL', () => {
    expect(formatOsc8Link('issue', `${ISSUE_URL}\u0007\n`)).toContain(
      `${ISSUE_URL}%07%0A`,
    );
  });

  it('recognizes known OSC 8 terminals and rejects unsafe environments', () => {
    expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(supportsOsc8Hyperlinks({ WT_SESSION: '1' })).toBe(true);
    expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: 'vscode' })).toBe(false);
    expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: 'vscode', FORCE_HYPERLINK: '1' })).toBe(true);
    expect(supportsOsc8Hyperlinks({ TERM: 'dumb' })).toBe(false);
    expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: 'unknown' })).toBe(false);
  });
});
