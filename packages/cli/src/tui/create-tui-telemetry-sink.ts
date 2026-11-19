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
  type Status = { text: string; since: number };
  const status = (text: string): Status => ({ text, since: Date.now() });
  let baseStatus = status('待機中');
  let compactionStatus: Status | undefined;
  let providerRetry: Status | undefined;
  let summarizationRetry: Status | undefined;
  return (event) => {
    if (event.type === 'conductor.send.started') baseStatus = status('処理中');
    if (event.type === 'conductor.output_phase' && baseStatus.text !== event.phase) baseStatus = status(event.phase);
    if (event.type === 'conductor.send.progress') baseStatus = status(`calling ${event.tool}`);
    if (event.type === 'conductor.send') {
      baseStatus = status('待機中');
      compactionStatus = undefined;
      providerRetry = undefined;
      summarizationRetry = undefined;
    }
    if (event.type === 'conductor.compaction') {
      if (event.event.type === 'start') compactionStatus = status(`compacting (${event.event.reason})`);
      else compactionStatus = event.event.outcome === 'failed' ? status('compaction failed') : undefined;
    }
    if (event.type === 'conductor.retry') {
      const retry = event.event;
      if (retry.type === 'auto_retry_start') {
        providerRetry = status(`retrying ${retry.attempt}/${retry.maxAttempts}`);
      } else if (retry.type === 'auto_retry_end') {
        providerRetry = retry.success ? undefined : status('retry failed');
      } else if (retry.type === 'summarization_retry_scheduled') {
        summarizationRetry = status(`retrying ${retry.attempt}/${retry.maxAttempts}`);
      } else if (retry.type === 'summarization_retry_attempt_start') {
        summarizationRetry ??= status('retrying');
      } else {
        summarizationRetry = undefined;
      }
    }
    if (event.type === 'conductor.send.started' || event.type === 'conductor.send.progress' || event.type === 'conductor.output_phase' || event.type === 'conductor.send' || event.type === 'conductor.compaction' || event.type === 'conductor.retry') {
      viewModel.setConductorStatus(providerRetry ?? summarizationRetry ?? compactionStatus ?? baseStatus);
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
