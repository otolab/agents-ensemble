import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { buildActivityLogDisplayLines } from './activity-log.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import {
  computeActivityLogLineCapacity,
  computeOperatorInputCursorX,
  computeOperatorInputLineIndex,
} from './compute-operator-input-cursor-y.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import { OPERATOR_INPUT_CURSOR_Y_OFFSET, PANE_PADDING_X, ROUND_BORDER_WIDTH } from './tui-layout-constants.js';

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
    });
    viewModel.appendActivityLog('operator', 'operator ping');
    viewModel.appendActivityLog('conductor', 'conductor says hi');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Workers');
    expect(frame).toContain('implementer');
    expect(frame).toContain('Orchestration');
    expect(frame).toContain('[operator] operator ping');
    expect(frame).toContain('[conductor] conductor says hi');
    expect(frame).toContain('Open questions');
    expect(frame).toContain('inq-1');
    expect(frame).toContain('operator>');
  });

  it('shows post-loop hint in input area', () => {
    const viewModel = createTuiViewModel();
    viewModel.setPostLoopWaiting(true);

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').toContain('post-loop 待機中');
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
    const expectedInputLineIndex = computeOperatorInputLineIndex({ terminalRows, hintLineCount });
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
    const expectedInputLineIndex = computeOperatorInputLineIndex({ terminalRows, hintLineCount });
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
    expect(frame).toContain('Workers');
    expectNoContentOnBorderLines(frame);
    expect(frame.split('\n')).toHaveLength(terminalRows);
  });

  it('shows empty-state placeholders when no session activity yet', () => {
    const viewModel = createTuiViewModel();

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('(待機中)');
    expect(frame).toContain('(活動ログなし)');
    expect(frame).toContain('(未回答なし)');
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

  it('allocates more rows to orchestration pane than auxiliary panes', () => {
    const capacity = computeActivityLogLineCapacity({
      terminalRows: 24,
      hintLineCount: 1,
    });

    expect(capacity).toBeGreaterThanOrEqual(7);
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
