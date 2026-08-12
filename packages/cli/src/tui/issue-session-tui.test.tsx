import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';

describe('IssueSessionTui', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders four panes with worker, conductor, open questions, and input', () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {
        implementer: { kind: 'implementer', status: 'running' },
      },
      conductorOutput: 'conductor says hi',
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
    viewModel.appendOperatorLine('operator ping');

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Workers');
    expect(frame).toContain('implementer');
    expect(frame).toContain('running');
    expect(frame).toContain('Conductor');
    expect(frame).toContain('conductor says hi');
    expect(frame).toContain('operator ping');
    expect(frame).toContain('Open questions');
    expect(frame).toContain('inq-1');
    expect(frame).toContain('Approve?');
    expect(frame).toContain('operator>');
  });

  it('shows post-loop waiting banner', () => {
    const viewModel = createTuiViewModel();
    viewModel.setPostLoopWaiting(true);

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    expect(lastFrame() ?? '').toContain('自律作業が一段落しました');
  });

  it('shows empty-state placeholders when no session activity yet', () => {
    const viewModel = createTuiViewModel();

    const { lastFrame } = render(
      <IssueSessionTui viewModel={viewModel} onSubmit={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('(待機中)');
    expect(frame).toContain('(応答待ち)');
    expect(frame).toContain('(未回答なし)');
  });
});
