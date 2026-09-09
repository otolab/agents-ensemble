import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-text-area.js', () => import('./operator-text-area.test-double.js'));

import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { buildActivityLogDisplayLines } from './activity-log.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import { extractOrchestrationPaneFrameStats, extractTuiPaneFrameStats } from './orchestration-pane-frame.js';
import { resolveOpenQuestionsPaneLayout } from './open-questions-pane.js';
import {
  computeActivityLogLineCapacity,
  computeActivityPaneHeight,
  computeOrchestrationLogVisibleLineCount,
  computeOperatorInputCursorX,
  computeOperatorInputLineIndex,
} from './compute-operator-input-cursor-y.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import {
  INPUT_PANE_TITLE,
  MAIN_PANE_TITLE,
  OPEN_QUESTIONS_PANE_MIN_HEIGHT,
  OPERATOR_INPUT_CURSOR_Y_OFFSET,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
  WORKER_PANE_TITLE,
} from './tui-layout-constants.js';
import type { OpenQuestion } from '@agents-ensemble/core';

function findOperatorInputLine(lines: string[]): { lineIndex: number; inputStartX: number } {
  const operatorLineIndices = lines
    .map((line, index) => (line.includes('operator>') ? index : -1))
    .filter((index) => index >= 0);
  const lineIndex = operatorLineIndices.at(-1) ?? -1;
  const line = lines[lineIndex] ?? '';
  const promptIndex = line.lastIndexOf('operator> ');
  const inputStartX = promptIndex >= 0 ? promptIndex + 'operator> '.length : -1;
  return { lineIndex, inputStartX };
}

function expectNoContentOnBorderLines(frame: string): void {
  for (const line of frame.split('\n')) {
    if (line.startsWith('╭') || line.startsWith('╰') || line.startsWith('┌') || line.startsWith('└')) {
      expect(line).not.toMatch(/\[(?:operator|conductor|implementer|reviewer)\]/);
      expect(line).not.toMatch(/operator>/);
    }
  }
}

function fillScrollableHarnessLog(viewModel: ReturnType<typeof createTuiViewModel>, count = 30): void {
  for (let index = 0; index < count; index++) {
    viewModel.appendActivityLog('harness', `line-${index}`);
  }
}

const SCROLL_HINT = 'PgUp/PgDn でスクロール';
const ISSUE_URL = 'https://github.com/otolab/agents-ensemble/issues/249';
const NON_CANONICAL_ISSUE_URL = 'http://github.com/otolab/agents-ensemble/issues/249/';

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

function resolveOpenQuestionsPaneHeight(
  openQuestions: OpenQuestion[],
  terminalRows = 24,
  terminalColumns = 80,
): number {
  return resolveOpenQuestionsPaneLayout({
    openQuestions,
    selectedIndex: 0,
    contentWidth: getPaneContentWidth({
      columns: terminalColumns,
      paddingX: PANE_PADDING_X,
      borderWidth: ROUND_BORDER_WIDTH,
    }),
    terminalRows,
  }).paneHeight;
}

describe('IssueSessionTui', () => {
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

  it('renders four panes with worker, session log, open questions, and input', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {
        implementer: { kind: 'implementer', status: 'running' },
      },
      conductorOutput: null,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Approve?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 1,
        },
      ],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.appendActivityLog('operator', 'operator ping');
    viewModel.appendActivityLog('conductor', 'conductor says hi');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain(WORKER_PANE_TITLE);
    expect(frame).toContain('implementer');
    expect(frame).toContain(MAIN_PANE_TITLE);
    expect(frame).toContain('[operator] operator ping');
    expect(frame).toContain('[conductor] conductor says hi');
    expect(frame).toContain('Open questions');
    expect(frame).toContain('inq-1');
    expect(frame).toContain('1/1');
    expect(frame).toContain('Shift+↑↓で選択');
    expect(frame).toContain('operator>');
    expect(frame).toContain(INPUT_PANE_TITLE);
  });

  it('shows dispatch hold count in the Workers pane title', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: true, heldEventCount: 3 },
    });

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').toContain('conductor dispatch 保留中（3 件）');
  });

  it('shows post-loop prompt in input area without waiting status', () => {
    const viewModel = createTuiViewModel();
    viewModel.setPostLoopWaiting(true);

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('追加指示を入力するか /exit で終了');
    expect(frame).not.toContain('post-loop 待機中');
  });

  it('shows the issue link in the workers pane header and prompt-only operator input', async () => {
    const viewModel = createTuiViewModel();
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 2,
      maxTurns: null,
      openQuestions: [],
    });

    const { lastFrame } = render(
      <IssueSessionTui
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        onSubmit={() => {}}
      />,
    );

    const issueLabel = 'otolab/agents-ensemble#249';
    const osc8Open = `\u001b]8;;${ISSUE_URL}\u0007`;
    const nonCanonicalOsc8Open = `\u001b]8;;${NON_CANONICAL_ISSUE_URL}\u0007`;
    const frame = lastFrame() ?? '';
    expect(frame).toContain(issueLabel);
    expect(frame).toContain(osc8Open);
    expect(frame).not.toContain(nonCanonicalOsc8Open);
    expect(frame).toContain('任意のタイミングで入力 · /exit で終了');
    expect(frame).not.toContain(`${issueLabel} — 任意のタイミングで入力 · /exit で終了`);

    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [createOpenQuestion({ id: 'inq-1', question: 'Continue?' })],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 2,
      maxTurns: null,
      openQuestions: [createOpenQuestion({ id: 'inq-1', question: 'Continue?' })],
    });
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain(issueLabel);
    expect(lastFrame() ?? '').toContain(osc8Open);
    expect(lastFrame() ?? '').not.toContain(nonCanonicalOsc8Open);
    expect(lastFrame() ?? '').toContain('inq-1 (1/1) への回答');

    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 2,
      maxTurns: null,
      openQuestions: [],
    });
    viewModel.setPostLoopWaiting(true);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain(issueLabel);
    expect(lastFrame() ?? '').toContain(osc8Open);
    expect(lastFrame() ?? '').not.toContain(nonCanonicalOsc8Open);
    expect(lastFrame() ?? '').toContain('追加指示を入力するか /exit で終了');
    expect(lastFrame() ?? '').not.toContain('post-loop 待機中');

    viewModel.setShuttingDown(true);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain(issueLabel);
    expect(lastFrame() ?? '').toContain(osc8Open);
    expect(lastFrame() ?? '').not.toContain(nonCanonicalOsc8Open);
    expect(lastFrame() ?? '').toContain('終了しています…');
    expect(lastFrame() ?? '').not.toContain(`${issueLabel} — 終了しています…`);
  });

  it('renders only the issue label in the workers header when OSC 8 is unavailable', () => {
    const viewModel = createTuiViewModel();
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });

    const { lastFrame } = render(
      <IssueSessionTui
        viewModel={viewModel}
        issueUrl={ISSUE_URL}
        issueLinkMode="label"
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('otolab/agents-ensemble#249');
    expect(frame).not.toContain('\u001b]8;;');
  });

  it('renders the canonical Issue URL in the workers header with URL fallback', () => {
    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTui
        viewModel={viewModel}
        issueUrl={NON_CANONICAL_ISSUE_URL}
        issueLinkMode="url"
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain(`${ISSUE_URL} ─╮`);
    expect(frame).not.toContain('otolab/agents-ensemble#249');
    expect(frame).not.toContain('\u001b]8;;');
  });

  it('keeps the canonical Issue URL in URL fallback at a narrow width', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTui
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
      <IssueSessionTui
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
      dispatchHold: { hold: true, heldEventCount: 3 },
    });

    const { lastFrame } = render(
      <IssueSessionTui
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

  it('truncates the issue label in the workers header on a narrow terminal', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });

    const { lastFrame } = render(
      <IssueSessionTui
        viewModel={viewModel}
        issueUrl={ISSUE_URL}
        issueLinkMode="label"
        onSubmit={() => {}}
      />,
    );

    const frame = lastFrame() ?? '';
    const workersBorderLine = frame.split('\n')[0] ?? '';
    expect(workersBorderLine).toContain('Workers');
    expect(workersBorderLine).toContain('…');
    expect(frame).not.toContain('\u001b]8;;');
  });

  it('closes the narrow Workers header Issue hyperlink before the border', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTui
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

  it('aligns IME cursor coordinates with the rendered operator input line', () => {
    const terminalRows = 24;
    const terminalColumns = 80;
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      get: () => terminalColumns,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      get: () => terminalRows,
    });

    const viewModel = createTuiViewModel();
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });
    const operatorPrompt = 'operator> ';
    const contentWidth = getPaneContentWidth({
      columns: terminalColumns,
      paddingX: PANE_PADDING_X,
      borderWidth: ROUND_BORDER_WIDTH,
    });
    const contextHint = formatOperatorContextHint(viewModel.getSnapshot().operatorContext);
    const hintLineCount = wrapTextToWidth(contextHint, contentWidth).length;
    const openQuestionsPaneHeight = 0;
    const expectedInputLineIndex = computeOperatorInputLineIndex({
      terminalRows,
      hintLineCount,
      openQuestionsPaneHeight,
    });
    const expectedCursorX = computeOperatorInputCursorX(operatorPrompt);
    const expectedCursorY = expectedInputLineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET;

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const lines = (lastFrame() ?? '').split('\n');
    const { lineIndex, inputStartX } = findOperatorInputLine(lines);
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(inputStartX).toBe(expectedCursorX);
    expect(lineIndex).toBe(expectedInputLineIndex);
    expect(expectedCursorY).toBe(lineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET);
    expect(lines).toHaveLength(terminalRows);
  });

  it('aligns IME cursor coordinates when context hint wraps on a narrow terminal', () => {
    const terminalRows = 24;
    const terminalColumns = 40;
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      get: () => terminalColumns,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      get: () => terminalRows,
    });

    const viewModel = createTuiViewModel();
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });
    const operatorPrompt = 'operator> ';
    const contentWidth = getPaneContentWidth({
      columns: terminalColumns,
      paddingX: PANE_PADDING_X,
      borderWidth: ROUND_BORDER_WIDTH,
    });
    const contextHint = formatOperatorContextHint(viewModel.getSnapshot().operatorContext);
    const hintLineCount = wrapTextToWidth(contextHint, contentWidth).length;
    const openQuestionsPaneHeight = 0;
    const expectedInputLineIndex = computeOperatorInputLineIndex({
      terminalRows,
      hintLineCount,
      openQuestionsPaneHeight,
    });
    const expectedCursorX = computeOperatorInputCursorX(operatorPrompt);
    const expectedCursorY = expectedInputLineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET;

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const lines = (lastFrame() ?? '').split('\n');
    const { lineIndex, inputStartX } = findOperatorInputLine(lines);
    expect(hintLineCount).toBeGreaterThan(1);
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(inputStartX).toBe(expectedCursorX);
    expect(lineIndex).toBe(expectedInputLineIndex);
    expect(expectedCursorY).toBe(lineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET);
    expect(lines).toHaveLength(terminalRows);
  });

  it('shows conductor thinking during in-flight send then idle on completion', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {
        conductor: { kind: 'conductor', status: 'running' },
        implementer: { kind: 'implementer', status: 'idle' },
      },
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });

    const { lastFrame: thinkingFrame, unmount: unmountThinking } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );
    expect(thinkingFrame() ?? '').toContain('conductor: thinking');
    unmountThinking();

    viewModel.setDisplayState({
      workers: {
        conductor: { kind: 'conductor', status: 'idle' },
        implementer: { kind: 'implementer', status: 'idle' },
      },
      conductorOutput: 'done',
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });

    const { lastFrame: idleFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );
    expect(idleFrame() ?? '').toContain('conductor: idle');
    expect(idleFrame() ?? '').not.toContain('conductor: thinking');
  });

  it('does not bleed activity log text onto pane border lines', () => {
    const terminalRows = 24;
    const terminalColumns = 80;
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      get: () => terminalColumns,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      get: () => terminalRows,
    });

    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {
        conductor: { kind: 'conductor', status: 'running' },
        implementer: { kind: 'implementer', status: 'running' },
        reviewer: { kind: 'reviewer', status: 'idle' },
      },
      conductorOutput: null,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Approve?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 1,
        },
      ],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    });
    for (let i = 0; i < 12; i++) {
      viewModel.appendActivityLog('conductor', `activity line ${i} with some longer text`);
    }

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain(WORKER_PANE_TITLE);
    expectNoContentOnBorderLines(frame);
    expect(frame.split('\n')).toHaveLength(terminalRows);
  });

  it('shows the no-question input mode when no session activity yet', () => {
    const viewModel = createTuiViewModel();

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('(待機中)');
    expect(frame).toContain('(活動ログなし)');
    expect(frame).not.toContain('Open questions');
    expect(frame).not.toContain('(未回答なし)');
    expect(frame).toContain('任意のタイミングで入力 · /exit で終了');
  });

  it('switches the lower UI between no-question and question modes', async () => {
    const viewModel = createTuiViewModel();
    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').not.toContain('Open questions');
    expect(lastFrame() ?? '').toContain('任意のタイミングで入力 · /exit で終了');

    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [createOpenQuestion({ id: 'inq-1', question: 'Answer?' })],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('Open questions');
    expect(lastFrame() ?? '').toContain('inq-1 (1/1) への回答');
    expect(lastFrame() ?? '').not.toContain('任意のタイミングで入力 · /exit で終了');

    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    await flushInkStdin();
    expect(lastFrame() ?? '').not.toContain('Open questions');
    expect(lastFrame() ?? '').toContain('任意のタイミングで入力 · /exit で終了');
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
      <IssueSessionTui
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

  it('renders all activity log label kinds with distinct markers', () => {
    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('operator', 'op');
    viewModel.appendActivityLog('harness', 'tel');
    viewModel.appendActivityLog('observation', 'obs');
    viewModel.appendActivityLog('conductor', 'cond');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[operator] op');
    expect(frame).toContain('[harness] tel');
    expect(frame).toContain('[observation] obs');
    expect(frame).toContain('[conductor] cond');
  });

  it('embeds pane titles on top borders without inner title rows', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [createOpenQuestion({ id: 'inq-1', question: 'Answer?' })],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
    viewModel.appendActivityLog('operator', 'ping');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    for (const title of [WORKER_PANE_TITLE, MAIN_PANE_TITLE, 'Open questions', INPUT_PANE_TITLE]) {
      const stats = extractTuiPaneFrameStats(frame, title);
      expect(stats.titleOnBorder).toBe(true);
      expect(stats.innerRows.some((line) => line.includes(title))).toBe(false);
    }
  });

  it('keeps orchestration title visible when log pane is full', () => {
    const viewModel = createTuiViewModel();
    fillScrollableHarnessLog(viewModel, 100);

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').toContain('Orchestration');
  });

  it('fills orchestration pane when scroll hint is shown on the top border', async () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 40,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 24,
    });

    const viewModel = createTuiViewModel();
    fillScrollableHarnessLog(viewModel, 50);

    const { stdin, lastFrame, unmount } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    stdin.write(INK_TEST_KEYS.pageUp);
    await flushInkStdin();

    const capacity = computeOrchestrationLogVisibleLineCount(
      computeActivityPaneHeight({
        terminalRows: 24,
        hintLineCount: 2,
        openQuestionsPaneHeight: 0,
      }),
    );
    const stats = extractOrchestrationPaneFrameStats(lastFrame() ?? '');

    expect(lastFrame() ?? '').toContain('PgUp/PgDn');
    expect(stats.titleRows).toHaveLength(0);
    expect(stats.logRows.length).toBeGreaterThanOrEqual(capacity);
    expect(stats.blankRows).toHaveLength(0);

    unmount();
  });

  it('fills orchestration pane log rows without unused inner blank lines', () => {
    for (const terminalRows of [24, 40, 50] as const) {
      Object.defineProperty(process.stdout, 'rows', {
        configurable: true,
        value: terminalRows,
      });

      const viewModel = createTuiViewModel();
      fillScrollableHarnessLog(viewModel, 100);

      const { lastFrame, unmount } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      const capacity = computeActivityLogLineCapacity({
        terminalRows,
        hintLineCount: 1,
        openQuestionsPaneHeight: 0,
      });
      const stats = extractOrchestrationPaneFrameStats(lastFrame() ?? '');

      expect(capacity).toBeGreaterThan(0);
      expect(stats.logRows.length).toBeGreaterThanOrEqual(capacity);
      expect(stats.blankRows).toHaveLength(0);

      unmount();
    }
  });

  it('windowing hides older log lines when orchestration pane is full', () => {
    const viewModel = createTuiViewModel();
    for (let index = 0; index < 30; index++) {
      viewModel.appendActivityLog('harness', `line-${index}`);
    }

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[harness] line-29');
    expect(frame).not.toContain('[harness] line-0');
  });

  it('renders multi-line activity body at full width without label-column indent', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 30,
    });

    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('conductor', 'alpha beta gamma');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    const continuationIndent = ' '.repeat('[conductor] '.length);
    expect(frame).toContain('[conductor]');
    expect(frame).not.toContain(`${continuationIndent}alpha`);
    expect(frame).not.toContain(`${continuationIndent}beta`);
  });

  it('keeps one-line entries as inline label and body', () => {
    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('operator', 'ping');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').toContain('[operator] ping');
  });

  it('uses manual wrap only (display line count matches wrap helper)', () => {
    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('conductor', 'word '.repeat(30));

    const contentWidth = 76;
    const expectedLines = buildActivityLogDisplayLines(
      viewModel.getSnapshot().activityLog,
      contentWidth,
    ).length;

    render(<IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />);

    expect(expectedLines).toBeGreaterThan(1);
  });

  it('renders multi-line operator input in activity log', () => {
    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('operator', 'first line\nsecond line');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[operator]');
    expect(frame).toContain('first line');
    expect(frame).toContain('second line');
  });

  it('renders blank lines between paragraphs in operator activity log', () => {
    const viewModel = createTuiViewModel();
    viewModel.appendActivityLog('operator', '段落1\n\n段落2');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frameLines = (lastFrame() ?? '').split('\n');
    const firstIndex = frameLines.findIndex((line) => line.includes('段落1'));
    const secondIndex = frameLines.findIndex((line) => line.includes('段落2'));
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex + 1);
  });

  describe('open questions selection (stdin integration)', () => {
    it('cycles selection with Shift+arrow keys', async () => {
      const viewModel = createTuiViewModel();
      viewModel.setDisplayState({
        workers: {},
        conductorOutput: null,
        openQuestions: [
          createOpenQuestion({ id: 'inq-1', question: 'First question' }),
          createOpenQuestion({ id: 'inq-2', question: 'Second question' }),
        ],
        dispatchHold: { hold: false, heldEventCount: 0 },
      });

      const { stdin, lastFrame } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      expect(lastFrame() ?? '').toContain('▸ inq-1');

      stdin.write(INK_TEST_KEYS.shiftDownArrow);
      await flushInkStdin();

      const frame = lastFrame() ?? '';
      expect(frame).toContain('2/2');
      expect(frame).toContain('▸ inq-2');
    });

    it('does not change selection on plain arrow keys', async () => {
      const viewModel = createTuiViewModel();
      viewModel.setDisplayState({
        workers: {},
        conductorOutput: null,
        openQuestions: [
          createOpenQuestion({ id: 'inq-1', question: 'First question' }),
          createOpenQuestion({ id: 'inq-2', question: 'Second question' }),
        ],
        dispatchHold: { hold: false, heldEventCount: 0 },
      });

      const { stdin, lastFrame } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      stdin.write(INK_TEST_KEYS.downArrow);
      await flushInkStdin();

      expect(lastFrame() ?? '').toContain('▸ inq-1');
      expect(lastFrame() ?? '').not.toContain('2/2');
    });

    it('submits selected question answer with targetOpenQuestionId', async () => {
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
      let submitted = '';
      let submitOptions: { targetOpenQuestionId?: string } | undefined;
      const { stdin, lastFrame } = render(
        <IssueSessionTui
          viewModel={viewModel}
          onSubmit={(text, options) => {
            submitted = text;
            submitOptions = options;
          }}
        />,
      );

      stdin.write(INK_TEST_KEYS.shiftDownArrow);
      await flushInkStdin();
      expect(lastFrame() ?? '').toContain('▸ inq-2');

      stdin.write('approved');
      await flushInkStdin();
      stdin.write('\r');
      await flushInkStdin();

      expect(submitted).toBe('approved');
      expect(submitOptions).toEqual({ targetOpenQuestionId: 'inq-2' });
    });

    it('submits ordinary input without an open-question target', async () => {
      const viewModel = createTuiViewModel();
      viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [],
      dispatchHold: { hold: false, heldEventCount: 0 },
    });
      const onSubmit = vi.fn();
      const { stdin } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={onSubmit} />,
      );

      stdin.write('follow-up');
      await flushInkStdin();
      stdin.write('\r');
      await flushInkStdin();

      expect(onSubmit).toHaveBeenCalledWith('follow-up', undefined);
    });

    it('grows open questions pane for long selected question text', () => {
      const viewModel = createTuiViewModel();
      viewModel.setDisplayState({
        workers: {},
        conductorOutput: null,
        openQuestions: [
          createOpenQuestion({
            id: 'inq-long',
            question: 'word '.repeat(30),
            context: 'context '.repeat(10),
          }),
        ],
        dispatchHold: { hold: false, heldEventCount: 0 },
      });

      const { lastFrame } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      const paneHeight = resolveOpenQuestionsPaneHeight(
        viewModel.getSnapshot().displayState.openQuestions,
      );
      expect(paneHeight).toBeGreaterThan(OPEN_QUESTIONS_PANE_MIN_HEIGHT);
      expect(lastFrame() ?? '').toContain('context context');
    });
  });

  describe('orchestration pane scroll (stdin integration)', () => {
    it('scrolls to older lines on PgUp when input is empty and shows scroll hint', async () => {
      const viewModel = createTuiViewModel();
      fillScrollableHarnessLog(viewModel);

      const { stdin, lastFrame } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      const pinnedFrame = lastFrame() ?? '';
      expect(pinnedFrame).toContain('[harness] line-29');
      expect(pinnedFrame).not.toContain('[harness] line-16');
      expect(pinnedFrame).not.toContain(SCROLL_HINT);

      stdin.write(INK_TEST_KEYS.pageUp);
      await flushInkStdin();

      const scrolledFrame = lastFrame() ?? '';
      expect(scrolledFrame).toContain(SCROLL_HINT);
      expect(scrolledFrame).toContain('[harness] line-16');
      expect(scrolledFrame).not.toContain('[harness] line-29');
    });

    it('returns to latest lines on End and clears scroll hint', async () => {
      const viewModel = createTuiViewModel();
      fillScrollableHarnessLog(viewModel);

      const { stdin, lastFrame } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      stdin.write(INK_TEST_KEYS.pageUp);
      await flushInkStdin();
      expect(lastFrame() ?? '').toContain(SCROLL_HINT);

      stdin.write(INK_TEST_KEYS.end);
      await flushInkStdin();

      const restoredFrame = lastFrame() ?? '';
      expect(restoredFrame).toContain('[harness] line-29');
      expect(restoredFrame).not.toContain(SCROLL_HINT);
    });

    it('does not scroll on plain PgUp when input has text; Ctrl+PgUp scrolls without changing input', async () => {
      const viewModel = createTuiViewModel();
      fillScrollableHarnessLog(viewModel);

      const { stdin, lastFrame } = render(
        <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
      );

      stdin.write('typed');
      await flushInkStdin();

      const typedFrame = lastFrame() ?? '';
      expect(typedFrame).toContain('typed');
      expect(typedFrame).toContain('[harness] line-29');
      expect(typedFrame).not.toContain(SCROLL_HINT);

      stdin.write(INK_TEST_KEYS.pageUp);
      await flushInkStdin();

      const plainPageUpFrame = lastFrame() ?? '';
      expect(plainPageUpFrame).toContain('typed');
      expect(plainPageUpFrame).toContain('[harness] line-29');
      expect(plainPageUpFrame).not.toContain(SCROLL_HINT);

      stdin.write(INK_TEST_KEYS.ctrlPageUp);
      await flushInkStdin();

      const ctrlPageUpFrame = lastFrame() ?? '';
      expect(ctrlPageUpFrame).toContain('typed');
      expect(ctrlPageUpFrame).toContain(SCROLL_HINT);
      expect(ctrlPageUpFrame).toContain('[harness] line-16');
      expect(ctrlPageUpFrame).not.toContain('[harness] line-29');
    });
  });
});
