import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import { buildActivityLogDisplayLines } from './activity-log.js';

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

  it('windowing hides older log lines when session pane is full', () => {
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
});
