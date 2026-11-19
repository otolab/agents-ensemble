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
  let baseStatus = '待機中';
  let compactionStatus: string | undefined;
  let retryStatus: string | undefined;
  return (event) => {
    if (event.type === 'conductor.send.started') baseStatus = '処理中';
    if (event.type === 'conductor.output_phase') baseStatus = event.phase;
    if (event.type === 'conductor.send.progress') baseStatus = `calling ${event.tool}`;
    if (event.type === 'conductor.send') {
      baseStatus = '待機中';
      compactionStatus = undefined;
      retryStatus = undefined;
    }
    if (event.type === 'conductor.compaction') {
      if (event.event.type === 'start') compactionStatus = `compacting (${event.event.reason})`;
      else compactionStatus = event.event.outcome === 'failed' ? 'compaction failed' : undefined;
    }
    if (event.type === 'conductor.retry') {
      const retry = event.event;
      if (retry.type === 'auto_retry_start' || retry.type === 'summarization_retry_scheduled') {
        retryStatus = `retrying ${retry.attempt}/${retry.maxAttempts}`;
      } else if (retry.type === 'auto_retry_end') {
        retryStatus = retry.success ? undefined : 'retry failed';
      } else if (retry.type === 'summarization_retry_attempt_start') {
        if (!retryStatus) retryStatus = 'retrying';
      } else {
        retryStatus = undefined;
      }
    }
    if (event.type === 'conductor.send.started' || event.type === 'conductor.send.progress' || event.type === 'conductor.output_phase' || event.type === 'conductor.send' || event.type === 'conductor.compaction' || event.type === 'conductor.retry') {
      viewModel.setConductorStatus(retryStatus ?? compactionStatus ?? baseStatus);
    }
    const harnessBody = formatHarnessLogBody(event, {
      verbose: options.verbose,
    });
    if (harnessBody) {
      viewModel.appendActivityLog('harness', harnessBody);
    }

    if (event.type === 'session.post_loop_wait') {
      viewModel.setPostLoopWaiting(true);
    }

    if (
      event.type === 'session.operator_exit' ||
      event.type === 'session.operator_close'
    ) {
      viewModel.setShuttingDown(true);
    }

    const observationBody = formatObservationLogBody(event);
    if (observationBody) {
      viewModel.appendActivityLog('observation', observationBody);
    }
  };
}
