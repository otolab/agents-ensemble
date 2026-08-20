import {
  formatPermissionSummaryForOperator,
  type SessionLogEvent,
} from '@agents-ensemble/core';

/** harness sink と TUI 活動ログで共有する行本文（prefix なし）。 */
export function formatHarnessLogBody(event: SessionLogEvent): string | undefined {
  switch (event.type) {
    case 'harness.worktree':
      return `worktree path=${event.path} branch=${event.branch} mode=${event.mode}`;
    case 'harness.worktree.removed':
      return `worktree.removed path=${event.path} branch=${event.branch}`;
    case 'harness.worktree.remove_skipped':
      return `worktree.remove_skipped path=${event.path} branch=${event.branch} reason=${event.reason}`;
    case 'harness.worktree.remove_failed':
      return `worktree.remove_failed path=${event.path} branch=${event.branch} error=${event.error}`;
    case 'harness.worker.prompt.started':
      return `worker.prompt.started name=${event.name} kind=${event.kind} source=${event.source}`;
    case 'harness.worker.prompt.completed':
      return `worker.prompt.completed name=${event.name} kind=${event.kind} source=${event.source} stopReason=${event.stopReason}`;
    case 'harness.worker.prompt.failed':
      return `worker.prompt.failed name=${event.name} kind=${event.kind} source=${event.source} error=${event.error}`;
    case 'harness.worker.acp.update':
      return undefined;
    case 'harness.worker.state':
      return `worker.state name=${event.name} kind=${event.kind} state=${event.state}`;
    case 'harness.session.workers':
      return `session.workers count=${event.workers.length} names=${event.workers.map((worker) => worker.name).join(',')}`;
    case 'operator.input':
      return `operator.input turn=${event.conductorTurn} bytes=${event.text.length}`;
    case 'conductor.send.started': {
      let line = `conductor.send.started n=${event.sendCount}`;
      if (event.dispatchSource) {
        line += ` source=${event.dispatchSource}`;
      }
      return line;
    }
    case 'conductor.send.progress':
      return undefined;
    case 'permission.pending':
      return formatPermissionSummaryForOperator(event.permission, {
        workerLabel: event.workerLabel,
      });
    case 'conductor.send': {
      let line = `conductor.send n=${event.sendCount} status=${event.status} workerDone=${event.workerDispatches} workerFailed=${event.workerFailures}`;
      if (event.status === 'error' && event.error) {
        line += ` error=${event.error.message}`;
      }
      return line;
    }
    case 'worker.round':
      return `worker.round name=${event.dispatch.name} kind=${event.dispatch.kind} source=${event.dispatch.source ?? 'conductor'} stopReason=${event.dispatch.promptResult.stopReason} path=${event.dispatch.worktree.path}`;
    case 'worker.failed':
      return `worker.failed name=${event.failure.name} kind=${event.failure.kind} error=${event.failure.error}`;
    case 'worker.process.stderr': {
      const name = event.workerName ? ` name=${event.workerName}` : '';
      return `worker.stderr${name} ${event.line}`;
    }
    case 'session.stop':
      return `session.stop reason=${event.stopReason}`;
    case 'harness.github.update':
      return `github.update items=${event.itemCount}`;
    case 'harness.github.monitor_error':
      return `github.monitor_error ${event.message}`;
    case 'harness.warning':
      return `warning: ${event.message}`;
    case 'harness.teardown': {
      if (!event.force && event.durationMs < 1000) {
        return undefined;
      }
      const phases = Object.entries(event.phases)
        .map(([name, ms]) => `${name}=${ms}ms`)
        .join(' ');
      return `teardown force=${event.force} total=${event.durationMs}ms${phases ? ` ${phases}` : ''}`;
    }
    case 'harness.teardown.phase':
      return `teardown.phase ${event.phase}`;
    default:
      return undefined;
  }
}

/** observation sink と TUI 活動ログで共有する行本文（prefix なし）。 */
export function formatObservationLogBody(event: SessionLogEvent): string | undefined {
  switch (event.type) {
    case 'open.question.enqueued':
      return `${event.question.id} [${event.question.responseType}] ${event.question.question}`;
    case 'escalation.recorded':
      return `${event.record.question} → ${event.record.answer}`;
    case 'session.worktree.notice':
      return '特別モード: メイン worktree で直接作業します（isolated worktree は作りません）';
    case 'session.continue':
      return `resuming session: conductorAgentId=${event.conductorAgentId}`;
    case 'session.post_loop_wait':
      return '自律作業が一段落しました。';
    case 'session.operator_exit':
      return '終了しています…';
    case 'conductor.auth.recovery':
      return event.hint;
    case 'conductor.auth.reconnect':
      return `[auth] conductor 再接続を試行 agentId=${event.agentId}`;
    default:
      return undefined;
  }
}

/** 非 TTY observation sink 向けの stderr 1 行（prefix 付き。auth recovery は hint をそのまま）。 */
export function formatObservationStderrLine(event: SessionLogEvent): string | undefined {
  if (event.type === 'conductor.auth.recovery' || event.type === 'conductor.auth.reconnect') {
    const body = formatObservationLogBody(event);
    return body;
  }

  const body = formatObservationLogBody(event);
  if (!body) {
    return undefined;
  }

  switch (event.type) {
    case 'open.question.enqueued':
      return `[open question] ${body}`;
    case 'escalation.recorded':
      return `[operator answer] ${body}`;
    case 'session.worktree.notice':
      return `[worktree] ${body}`;
    case 'session.continue':
      return `[continue] ${body}`;
    case 'session.post_loop_wait':
      return `\n${body}\n`;
    case 'session.operator_exit':
      return `\n${body}\n`;
    default:
      return undefined;
  }
}

/** TUI 活動ログ向け conductor 応答本文。 */
export function formatConductorActivityBody(event: SessionLogEvent): string | undefined {
  if (event.type !== 'conductor.send') {
    return undefined;
  }
  if (event.status === 'finished' && event.result?.trim()) {
    return event.result.trim();
  }
  if (event.status === 'error') {
    const detail = event.error?.message ?? 'unknown error';
    return `応答を生成できませんでした（${detail}）。別の聞き方で再入力してください。`;
  }
  return undefined;
}
