import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import {
  computeOperatorInputCursorX,
  computeOperatorInputCursorY,
} from './compute-operator-input-cursor-y.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import { PANE_PADDING_X, ROUND_BORDER_WIDTH } from './tui-layout-constants.js';

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

describe('IssueSessionTui', () => {
  afterEach(() => {
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
    expect(frame).toContain('Session');
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
    const expectedCursorY = computeOperatorInputCursorY({ terminalRows, hintLineCount });
    const expectedCursorX = computeOperatorInputCursorX(operatorPrompt);

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const lines = (lastFrame() ?? '').split('\n');
    const { lineIndex, inputStartX } = findOperatorInputLine(lines);
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(inputStartX).toBe(expectedCursorX);
    expect(lineIndex).toBe(expectedCursorY);
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
    const expectedCursorY = computeOperatorInputCursorY({ terminalRows, hintLineCount });
    const expectedCursorX = computeOperatorInputCursorX(operatorPrompt);

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const lines = (lastFrame() ?? '').split('\n');
    const { lineIndex, inputStartX } = findOperatorInputLine(lines);
    expect(hintLineCount).toBeGreaterThan(1);
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(inputStartX).toBe(expectedCursorX);
    expect(lineIndex).toBe(expectedCursorY);
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
});
