import type { SessionLogSink } from '@agents-ensemble/core';
import {
  formatHarnessLogBody,
  formatObservationLogBody,
} from '../session-log-lines.js';
import type { TuiViewModel } from './tui-view-model.js';

export interface TuiTelemetrySinkOptions {
  /** 既定の要約に加えて従来のイベント単位行を活動ログへ表示する。 */
  verbose?: boolean;
}

/** TTY Ink 時: harness / observation を stderr ではなく活動ログへ送る sink。 */
export function createTuiTelemetrySink(
  viewModel: TuiViewModel,
  options: TuiTelemetrySinkOptions = {},
): SessionLogSink {
  return (event) => {
    const harnessBody = formatHarnessLogBody(event, {
      verbose: options.verbose,
    });
    if (harnessBody) {
      viewModel.appendActivityLog('harness', harnessBody);
    }

    if (event.type === 'session.post_loop_wait') {
      viewModel.setPostLoopWaiting(true);
    }

    if (event.type === 'session.operator_exit') {
      viewModel.setShuttingDown(true);
    }

    const observationBody = formatObservationLogBody(event);
    if (observationBody) {
      viewModel.appendActivityLog('observation', observationBody);
    }
  };
}
