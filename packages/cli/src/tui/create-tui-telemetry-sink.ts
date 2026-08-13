import type { SessionLogSink } from '@agents-ensemble/core';
import {
  formatHarnessLogBody,
  formatObservationLogBody,
} from '../session-log-lines.js';
import type { TuiViewModel } from './tui-view-model.js';

/** TTY Ink 時: harness / observation を stderr ではなく Orchestration メインペインへ送る sink。 */
export function createTuiTelemetrySink(viewModel: TuiViewModel): SessionLogSink {
  return (event) => {
    const harnessBody = formatHarnessLogBody(event);
    if (harnessBody) {
      viewModel.appendActivityLog('harness', harnessBody);
    }

    const observationBody = formatObservationLogBody(event);
    if (observationBody) {
      viewModel.appendActivityLog('observation', observationBody);
    }

    if (event.type === 'session.post_loop_wait') {
      viewModel.setPostLoopWaiting(true);
    }

    if (event.type === 'session.operator_exit') {
      viewModel.setShuttingDown(true);
    }
  };
}
