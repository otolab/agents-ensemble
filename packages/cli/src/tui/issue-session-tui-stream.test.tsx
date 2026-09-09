import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-text-area.js', () => import('./operator-text-area.test-double.js'));

import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import type { OpenQuestion } from '@agents-ensemble/core';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { createTuiViewModel } from './tui-view-model.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';

function createOpenQuestion(
  overrides: Partial<OpenQuestion> & Pick<OpenQuestion, 'id' | 'question'>,
): OpenQuestion {
  return {
    responseType: 'text',
    source: 'conductor',
    status: 'open',
    askedAt: 1,
    ...overrides,
  };
}

const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/261';
const NON_CANONICAL_ISSUE_URL = 'http://github.com/otolab/agents-ensemble/issues/261/';

describe('IssueSessionTuiStream', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 24,
    });
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 80,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders activity as unframed static output and keeps the lower panes framed', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {
        implementer: { kind: 'implementer', status: 'running' },
      },
      conductorOutput: null,
      openQuestions: [createOpenQuestion({ id: 'inq-1', question: 'Approve?' })],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.appendActivityLog('operator', 'operator ping');
    viewModel.appendActivityLog('conductor', 'conductor says hi');

    const { lastFrame } = render(
      <IssueSessionTuiStream viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[operator] operator ping');
    expect(frame).toContain('[conductor] conductor says hi');
    expect(frame).toContain('Workers');
    expect(frame).toContain('Open questions');
    expect(frame).toContain('Operator input');
    expect(frame).not.toContain('Orchestration');
    expect(frame.indexOf('Open questions')).toBeLessThan(frame.indexOf('Operator input'));
    expect(frame.indexOf('Operator input')).toBeLessThan(frame.indexOf('Workers'));
    expect(frame).toContain('inq-1 (1/1) への回答');
    expect(frame).not.toContain('任意のタイミングで入力 · /exit で終了');
  });

  it('shows dispatch hold count in the Workers pane title', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: true, heldEventCount: 4 },
    });

    const { lastFrame } = render(
      <IssueSessionTuiStream viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').toContain('conductor dispatch 保留中（4 件）');
  });

  it('shows the single-line post-loop prompt without waiting status', () => {
    const viewModel = createTuiViewModel();
    viewModel.setPostLoopWaiting(true);

    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl="https://github.com/otolab/agents-ensemble/issues/261"
        issueLinkMode="label"
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    const operatorInputIndex = frame.indexOf('Operator input');
    const instructionHintIndex = frame.indexOf('追加指示を入力するか /exit で終了');
    const workersIndex = frame.indexOf('Workers');

    expect(operatorInputIndex).toBeGreaterThanOrEqual(0);
    expect(frame).not.toContain('Open questions');
    expect(frame).not.toContain('(未回答なし)');
    expect(instructionHintIndex).toBeGreaterThan(operatorInputIndex);
    expect(workersIndex).toBeGreaterThan(operatorInputIndex);
    expect(frame).toContain('追加指示を入力するか /exit で終了');
    expect(frame).toContain('otolab/agents-ensemble#261');
    expect(frame).not.toContain('post-loop 待機中');
    expect(Math.max(...frame.split('\n').map((line) => line.trimEnd().length))).toBeLessThanOrEqual(80);
  });

  it('uses the canonical Issue URL for the Workers header OSC 8 target', () => {
    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('otolab/agents-ensemble#261');
    expect(frame).toContain(`\u001b]8;;${ISSUE_URL}\u0007`);
    expect(frame).not.toContain(`\u001b]8;;${NON_CANONICAL_ISSUE_URL}\u0007`);
  });

  it('renders the canonical Issue URL in the Workers header with URL fallback', () => {
    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        issueLinkMode="url"
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain(`${ISSUE_URL} ─╮`);
    expect(frame).not.toContain('otolab/agents-ensemble#261');
    expect(frame).not.toContain('\u001b]8;;');
  });

  it('keeps the canonical Issue URL in URL fallback at a narrow width', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        issueLinkMode="url"
        onSubmit={() => {}}
      />,
    );

    const workersBorderLine =
      (lastFrame() ?? '').split('\n').find((line) => line.includes('Workers')) ?? '';
    expect(workersBorderLine).toContain(ISSUE_URL);
    expect(workersBorderLine).toContain(`${ISSUE_URL} ─╮`);
    expect(workersBorderLine).not.toContain('https:/…');
    expect(workersBorderLine).not.toContain('\u001b]8;;');
  });

  it('keeps the canonical Issue URL in URL fallback across context lifecycle states', async () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        issueLinkMode="url"
        onSubmit={() => {}}
      />,
    );

    const expectCanonicalIssueUrl = () => {
      const workersBorderLine =
        (lastFrame() ?? '').split('\n').find((line) => line.includes('Workers')) ?? '';
      expect(workersBorderLine).toContain(ISSUE_URL);
      expect(workersBorderLine).toContain(`${ISSUE_URL} ─╮`);
      expect(workersBorderLine).not.toContain('https:/…');
      expect(workersBorderLine).not.toContain('\u001b]8;;');
    };

    expectCanonicalIssueUrl();

    const question = createOpenQuestion({ id: 'inq-1', question: 'Continue?' });
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [question],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [question],
    });
    await flushInkStdin();
    expectCanonicalIssueUrl();
    expect(lastFrame() ?? '').toContain('inq-1 (1/1)');
    expect(lastFrame() ?? '').toContain('への回答');

    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });
    viewModel.setPostLoopWaiting(true);
    await flushInkStdin();
    expectCanonicalIssueUrl();
    expect(lastFrame() ?? '').toContain('追加指示を入力するか');
    expect(lastFrame() ?? '').toContain('/exit で終了');

    viewModel.setShuttingDown(true);
    await flushInkStdin();
    expectCanonicalIssueUrl();
    expect(lastFrame() ?? '').toContain('終了しています…');
  });

  it('preserves the canonical Issue URL when dispatch hold adds a title suffix', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: true, heldEventCount: 4 },
    });

    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        issueLinkMode="url"
        onSubmit={() => {}}
      />,
    );

    const workersBorderLine =
      (lastFrame() ?? '').split('\n').find((line) => line.includes('Workers')) ?? '';
    expect(workersBorderLine).toContain(ISSUE_URL);
    expect(workersBorderLine).toContain(`${ISSUE_URL} ─╮`);
    expect(workersBorderLine).not.toContain('https://github.com/otolab/a…');
    expect(workersBorderLine).not.toContain('\u001b]8;;');
  });

  it('closes the narrow Workers header Issue hyperlink before the border', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        onSubmit={() => {}}
      />,
    );

    const workersBorderLine =
      (lastFrame() ?? '').split('\n').find((line) => line.includes('Workers')) ?? '';
    const canonicalOsc8Open = `\u001b]8;;${ISSUE_URL}\u0007`;
    const osc8Close = '\u001b]8;;\u0007';
    const linkOpenIndex = workersBorderLine.indexOf(canonicalOsc8Open);
    const linkCloseIndex = workersBorderLine.indexOf(
      osc8Close,
      linkOpenIndex + canonicalOsc8Open.length,
    );
    const closingBorderIndex = workersBorderLine.lastIndexOf('─╮');

    expect(workersBorderLine).toContain(
      `${canonicalOsc8Open}otolab/a…${osc8Close}`,
    );
    expect(workersBorderLine).not.toContain(
      `\u001b]8;;${NON_CANONICAL_ISSUE_URL}\u0007`,
    );
    expect(linkCloseIndex).toBeGreaterThan(linkOpenIndex);
    expect(linkCloseIndex).toBeLessThan(closingBorderIndex);
    expect(workersBorderLine.slice(closingBorderIndex)).not.toContain(osc8Close);
    expect(workersBorderLine.match(/\u001b\]8;;/g)).toHaveLength(2);
  });

  it('keeps the canonical Issue URL across stream context lifecycle states', async () => {
    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        onSubmit={() => {}}
      />,
    );
    const canonicalOsc8Open = `\u001b]8;;${ISSUE_URL}\u0007`;
    const nonCanonicalOsc8Open = `\u001b]8;;${NON_CANONICAL_ISSUE_URL}\u0007`;

    const expectCanonicalIssueLink = () => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain(canonicalOsc8Open);
      expect(frame).not.toContain(nonCanonicalOsc8Open);
    };

    expectCanonicalIssueLink();

    const question = createOpenQuestion({ id: 'inq-1', question: 'Continue?' });
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [question],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [question],
    });
    await flushInkStdin();
    expectCanonicalIssueLink();
    expect(lastFrame() ?? '').toContain('inq-1 (1/1) への回答');

    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });
    viewModel.setPostLoopWaiting(true);
    await flushInkStdin();
    expectCanonicalIssueLink();
    expect(lastFrame() ?? '').toContain('追加指示を入力するか /exit で終了');

    viewModel.setShuttingDown(true);
    await flushInkStdin();
    expectCanonicalIssueLink();
    expect(lastFrame() ?? '').toContain('終了しています…');
  });

  it('shows the no-question hint before operator context binds', () => {
    const viewModel = createTuiViewModel();

    const { lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl="https://github.com/otolab/agents-ensemble/issues/261"
        issueLinkMode="label"
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('任意のタイミングで入力 · /exit で終了');
    expect(frame).not.toContain('自律ターン');
  });

  it('omits the open-question pane and keeps ordinary input available', async () => {
    const viewModel = createTuiViewModel();
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl="https://github.com/otolab/agents-ensemble/issues/263"
        issueLinkMode="label"
        onSubmit={onSubmit}
      />,
    );

    expect(lastFrame() ?? '').not.toContain('Open questions');
    expect(lastFrame() ?? '').toContain('任意のタイミングで入力 · /exit で終了');
    expect(lastFrame() ?? '').toContain('otolab/agents-ensemble#263');
    expect(lastFrame() ?? '').not.toContain('otolab/agents-ensemble#263 — 任意のタイミングで入力 · /exit で終了');

    stdin.write('follow-up');
    await flushInkStdin();
    stdin.write('\r');
    await flushInkStdin();

    expect(onSubmit).toHaveBeenCalledWith('follow-up', undefined);
  });

  it('appends a later activity entry without replacing the earlier static entry', async () => {
    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('harness', 'first');

    const { lastFrame } = render(
      <IssueSessionTuiStream viewModel={viewModel} onSubmit={() => {}} />,
    );
    expect(lastFrame() ?? '').toContain('[harness] first');

    viewModel.appendActivityLog('observation', 'second');
    await flushInkStdin();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[harness] first');
    expect(frame).toContain('[observation] second');
  });

  it('submits input for the selected open question', async () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [createOpenQuestion({ id: 'inq-1', question: 'Need input' })],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    const onSubmit = vi.fn();

    const { stdin } = render(
      <IssueSessionTuiStream viewModel={viewModel} onSubmit={onSubmit} />,
    );

    stdin.write('approved');
    await flushInkStdin();
    stdin.write('\r');
    await flushInkStdin();

    expect(onSubmit).toHaveBeenCalledWith('approved', {
      targetOpenQuestionId: 'inq-1',
    });
  });

  it.each([
    [
      'one restored question',
      [createOpenQuestion({ id: 'inq-resumed-1', question: 'Resume one?' })],
    ],
    [
      'multiple restored questions',
      [
        createOpenQuestion({ id: 'inq-resumed-1', question: 'Resume first?' }),
        createOpenQuestion({ id: 'inq-resumed-2', question: 'Resume second?' }),
      ],
    ],
  ])('renders %s from the resumed operator context', async (_name, restoredQuestions) => {
    const viewModel = createTuiViewModel();
    const setOperatorQuestions = (openQuestions: OpenQuestion[]) => {
      viewModel.setOperatorContext({
        conductorTurn: 2,
        autonomousTurns: 1,
        maxTurns: null,
        openQuestions,
      });
    };
    setOperatorQuestions(restoredQuestions);
    const selectedIndex = restoredQuestions.length > 1 ? 1 : 0;
    let submittedOptions: { targetOpenQuestionId?: string } | undefined;

    const { stdin, lastFrame } = render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        onSubmit={(_text, options) => {
          setOperatorQuestions(
            restoredQuestions.filter((_question, index) => index !== selectedIndex),
          );
          submittedOptions = options;
        }}
      />,
    );

    const initialFrame = lastFrame() ?? '';
    expect(initialFrame).toContain('Open questions');
    expect(initialFrame).toContain('inq-resumed-1');
    expect(initialFrame).not.toContain('任意のタイミングで入力 · /exit で終了');

    if (selectedIndex === 1) {
      stdin.write(INK_TEST_KEYS.shiftDownArrow);
      await flushInkStdin();
    }
    stdin.write('answer');
    await flushInkStdin();
    stdin.write('\r');
    await flushInkStdin();

    expect(submittedOptions).toEqual({
      targetOpenQuestionId: restoredQuestions[selectedIndex]?.id,
    });
    if (restoredQuestions.length === 1) {
      expect(lastFrame() ?? '').not.toContain('Open questions');
      expect(lastFrame() ?? '').toContain('任意のタイミングで入力 · /exit で終了');
    } else {
      expect(lastFrame() ?? '').toContain('Open questions');
      expect(lastFrame() ?? '').toContain('inq-resumed-1');
      expect(lastFrame() ?? '').not.toContain('任意のタイミングで入力 · /exit で終了');

      setOperatorQuestions([]);
      await flushInkStdin();
      expect(lastFrame() ?? '').not.toContain('Open questions');
      expect(lastFrame() ?? '').toContain('任意のタイミングで入力 · /exit で終了');
    }
  });

  it('keeps Shift+arrow open-question selection in stream mode', async () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [
        createOpenQuestion({ id: 'inq-1', question: 'First' }),
        createOpenQuestion({ id: 'inq-2', question: 'Second' }),
      ],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });

    const { stdin, lastFrame } = render(
      <IssueSessionTuiStream viewModel={viewModel} onSubmit={() => {}} />,
    );

    stdin.write(INK_TEST_KEYS.shiftDownArrow);
    await flushInkStdin();

    expect(lastFrame() ?? '').toContain('2/2');
    expect(lastFrame() ?? '').toContain('▸ inq-2');
  });
});
