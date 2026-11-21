import type { OperatorPiActivity } from './run-operator-agent-types.js';
import type { createOperatorAgentTuiHost } from '../tui/operator-agent-tui.js';

export function createOperatorStatus(
  tui: ReturnType<typeof createOperatorAgentTuiHost>,
  signal: AbortSignal,
  isAgentSendInFlight: () => boolean,
) {
  let baseStatus = '待機中';
  let baseStatusSince = Date.now();
  let compactionSince: number | undefined;
  let autoRetry: { label: string; since: number } | undefined;
  let summaryRetry: { label: string; since: number } | undefined;
  const renderStatus = () => {
    if (baseStatus === 'reconnecting') tui.setStatus(baseStatus, baseStatusSince);
    else if (autoRetry) tui.setStatus(autoRetry.label, autoRetry.since);
    else if (summaryRetry) tui.setStatus(summaryRetry.label, summaryRetry.since);
    else if (compactionSince !== undefined) tui.setStatus('compacting', compactionSince);
    else tui.setStatus(baseStatus, baseStatusSince);
  };
  const setStatus = (status: string, since?: number) => {
    if (since !== undefined || status !== baseStatus) baseStatusSince = since ?? Date.now();
    baseStatus = status;
    renderStatus();
  };
  const listener: NonNullable<OperatorPiActivity['listener']> = (notification) => {
    if (signal.aborted) return;
    const event = notification.value;
    if (event.type === 'start' || event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled' || (event.type === 'summarization_retry_attempt_start' && !summaryRetry)) {
      if (baseStatus !== 'reconnecting') {
        baseStatus = isAgentSendInFlight() ? '処理中' : '待機中';
        baseStatusSince = Date.now();
      }
    }
    if (notification.kind === 'compaction') {
      if (event.type === 'start') compactionSince = Date.now();
      else compactionSince = undefined;
    } else if (event.type === 'auto_retry_start') {
      autoRetry = { label: `retrying (${event.attempt}/${event.maxAttempts})`, since: Date.now() };
    } else if (event.type === 'auto_retry_end') autoRetry = undefined;
    else if (event.type === 'summarization_retry_scheduled') {
      summaryRetry = { label: `retrying (${event.attempt}/${event.maxAttempts})`, since: Date.now() };
    } else if (event.type === 'summarization_retry_attempt_start' && !summaryRetry) {
      summaryRetry = { label: 'retrying', since: Date.now() };
    } else if (event.type === 'summarization_retry_finished') summaryRetry = undefined;
    renderStatus();
  };
  return {
    setStatus,
    listener,
    clearActivity: () => {
      compactionSince = undefined;
      autoRetry = undefined;
      summaryRetry = undefined;
    },
  };
}
