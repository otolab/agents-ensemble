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
  });

  it('nests the empty open-question state in input and shows the no-question hint', () => {
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
    const openQuestionsIndex = frame.indexOf('Open questions');
    const hintIndex = frame.indexOf('post-loop 待機中');
    const workersIndex = frame.indexOf('Workers');

    expect(operatorInputIndex).toBeGreaterThanOrEqual(0);
    expect(openQuestionsIndex).toBeGreaterThan(operatorInputIndex);
    expect(hintIndex).toBeGreaterThan(openQuestionsIndex);
    expect(workersIndex).toBeGreaterThan(operatorInputIndex);
    expect(frame).toContain('(未回答なし)');
    expect(frame).toContain(
      'otolab/agents-ensemble#261 — post-loop 待機中 — 追加指示を入力するか /exit',
    );
    expect(frame).toContain('で終了');
    expect(Math.max(...frame.split('\n').map((line) => line.trimEnd().length))).toBeLessThanOrEqual(80);
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

  it('keeps Shift+arrow open-question selection in stream mode', async () => {
    const viewModel = createTuiViewModel();
    viewModel.setDisplayState({
      workers: {},
      conductorOutput: null,
      openQuestions: [
        createOpenQuestion({ id: 'inq-1', question: 'First' }),
        createOpenQuestion({ id: 'inq-2', question: 'Second' }),
      ],
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
