import { describe, expect, it } from 'vitest';
import { createTuiTelemetrySink } from './create-tui-telemetry-sink.js';
import { createTuiViewModel } from './tui-view-model.js';

describe('createTuiTelemetrySink', () => {
  it('appends harness and observation events to activity log', () => {
    const viewModel = createTuiViewModel();
    const sink = createTuiTelemetrySink(viewModel);

    sink({
      type: 'harness.worker.bootstrap.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'worker-1',
    });
    sink({
      type: 'open.question.enqueued',
      question: {
        id: 'inq-1',
        question: 'Continue?',
        responseType: 'text',
        source: 'conductor',
        status: 'open',
        askedAt: 1,
      },
    });
    sink({ type: 'session.post_loop_wait' });

    const snapshot = viewModel.getSnapshot();
    expect(snapshot.activityLog).toEqual([
      {
        label: 'harness',
        text: 'worker.bootstrap.started name=implementer kind=implementer',
      },
      {
        label: 'observation',
        text: 'inq-1 [text] Continue?',
      },
      {
        label: 'observation',
        text: '自律作業が一段落しました。追加の指示を入力するか、/exit で終了してください。',
      },
    ]);
    expect(snapshot.postLoopWaiting).toBe(true);
  });

  it('appends conductor.auth.recovery to observation activity log', () => {
    const viewModel = createTuiViewModel();
    const sink = createTuiTelemetrySink(viewModel);

    sink({
      type: 'conductor.auth.recovery',
      agentId: 'agent-1',
      hint: '[auth] re-login required',
    });

    expect(viewModel.getSnapshot().activityLog).toEqual([
      {
        label: 'observation',
        text: '[auth] re-login required',
      },
    ]);
  });
});
