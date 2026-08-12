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
});
