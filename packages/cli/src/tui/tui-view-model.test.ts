import { describe, expect, it } from 'vitest';
import { createTuiViewModel } from './tui-view-model.js';

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
