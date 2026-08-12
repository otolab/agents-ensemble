import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { computeOperatorInputCursorY } from './compute-operator-input-cursor-y.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import { PANE_PADDING_X, ROUND_BORDER_WIDTH } from './tui-layout-constants.js';

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

  it('aligns IME cursor Y with the rendered operator input line', () => {
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
    const contentWidth = getPaneContentWidth({
      columns: terminalColumns,
      paddingX: PANE_PADDING_X,
      borderWidth: ROUND_BORDER_WIDTH,
    });
    const contextHint = formatOperatorContextHint(viewModel.getSnapshot().operatorContext);
    const hintLineCount = wrapTextToWidth(contextHint, contentWidth).length;
    const inputCursorY = computeOperatorInputCursorY({ terminalRows, hintLineCount });

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const lines = (lastFrame() ?? '').split('\n');
    const operatorLineIndices = lines
      .map((line, index) => (line.includes('operator>') ? index : -1))
      .filter((index) => index >= 0);
    const operatorLineIndex = operatorLineIndices.at(-1) ?? -1;
    expect(operatorLineIndex).toBeGreaterThanOrEqual(0);
    expect(inputCursorY).toBe(operatorLineIndex);
    expect(lines).toHaveLength(terminalRows);
  });

  it('aligns IME cursor Y when context hint wraps on a narrow terminal', () => {
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
    const contentWidth = getPaneContentWidth({
      columns: terminalColumns,
      paddingX: PANE_PADDING_X,
      borderWidth: ROUND_BORDER_WIDTH,
    });
    const contextHint = formatOperatorContextHint(viewModel.getSnapshot().operatorContext);
    const hintLineCount = wrapTextToWidth(contextHint, contentWidth).length;
    const inputCursorY = computeOperatorInputCursorY({ terminalRows, hintLineCount });

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const lines = (lastFrame() ?? '').split('\n');
    const operatorLineIndices = lines
      .map((line, index) => (line.includes('operator>') ? index : -1))
      .filter((index) => index >= 0);
    const operatorLineIndex = operatorLineIndices.at(-1) ?? -1;
    expect(hintLineCount).toBeGreaterThan(1);
    expect(operatorLineIndex).toBeGreaterThanOrEqual(0);
    expect(inputCursorY).toBe(operatorLineIndex);
    expect(lines).toHaveLength(terminalRows);
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
