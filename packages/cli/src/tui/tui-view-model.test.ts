import { describe, expect, it } from 'vitest';
import { createTuiViewModel, getTuiOpenQuestions } from './tui-view-model.js';

const RESTORED_QUESTION = {
  id: 'inq-resumed',
  question: 'Continue after resume?',
  responseType: 'text' as const,
  source: 'conductor' as const,
  status: 'open' as const,
  askedAt: 1,
};

describe('getTuiOpenQuestions', () => {
  it('uses the operator context registry snapshot after resume', () => {
    const snapshot = {
      displayState: {
        workers: {},
        conductorOutput: null,
        openQuestions: [],
      },
      activityLog: [],
      postLoopWaiting: false,
      shuttingDown: false,
      operatorContext: {
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: null,
        openQuestions: [RESTORED_QUESTION],
      },
    } satisfies Parameters<typeof getTuiOpenQuestions>[0];

    expect(getTuiOpenQuestions(snapshot)).toEqual([RESTORED_QUESTION]);
  });

  it('falls back to display events before the operator binding is ready', () => {
    const snapshot = {
      displayState: {
        workers: {},
        conductorOutput: null,
        openQuestions: [RESTORED_QUESTION],
      },
      activityLog: [],
      postLoopWaiting: false,
      shuttingDown: false,
      operatorContext: undefined,
    } satisfies Parameters<typeof getTuiOpenQuestions>[0];

    expect(getTuiOpenQuestions(snapshot)).toEqual([RESTORED_QUESTION]);
  });
});

describe('createTuiViewModel activity log', () => {
  it('appends labeled activity log entries', () => {
    const model = createTuiViewModel();

    model.appendActivityLog('operator', 'ping');
    model.appendActivityLog('conductor', 'pong');

    expect(model.getSnapshot().activityLog).toEqual([
      { label: 'operator', text: 'ping' },
      { label: 'conductor', text: 'pong' },
    ]);
  });

  it('ignores empty activity log lines', () => {
    const model = createTuiViewModel();
    model.appendActivityLog('harness', '   ');
    expect(model.getSnapshot().activityLog).toEqual([]);
  });

  it('appends separator entries for conductor spacing', () => {
    const model = createTuiViewModel();
    model.appendActivityLogSeparator();
    model.appendActivityLog('conductor', 'reply');
    model.appendActivityLogSeparator();

    expect(model.getSnapshot().activityLog).toEqual([
      { label: 'separator', text: '' },
      { label: 'conductor', text: 'reply' },
      { label: 'separator', text: '' },
    ]);
  });

  it('keeps the activity log append-only for Ink Static when requested', () => {
    const model = createTuiViewModel({ activityLogWindowSize: null });

    for (let index = 0; index < 301; index++) {
      model.appendActivityLog('harness', `line-${index}`);
    }

    expect(model.getSnapshot().activityLog).toHaveLength(301);
    expect(model.getSnapshot().activityLog[0]).toEqual({
      label: 'harness',
      text: 'line-0',
    });
  });

  it('keeps the existing bounded activity window by default', () => {
    const model = createTuiViewModel();

    for (let index = 0; index < 301; index++) {
      model.appendActivityLog('harness', `line-${index}`);
    }

    expect(model.getSnapshot().activityLog).toHaveLength(300);
    expect(model.getSnapshot().activityLog[0]).toEqual({
      label: 'harness',
      text: 'line-1',
    });
  });
});
