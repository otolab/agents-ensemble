import type { SessionLogEvent } from '@agents-ensemble/core';

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
    case 'harness.worker.bootstrap.started':
      return `worker.bootstrap.started name=${event.name} kind=${event.kind}`;
    case 'harness.worker.bootstrap.completed':
      return `worker.bootstrap.completed name=${event.name} kind=${event.kind} stopReason=${event.stopReason}`;
    case 'harness.worker.bootstrap.failed':
      return `worker.bootstrap.failed name=${event.name} kind=${event.kind} error=${event.error}`;
    case 'operator.input':
      return `operator.input turn=${event.conductorTurn} bytes=${event.text.length}`;
    case 'conductor.send': {
      let line = `conductor.send n=${event.sendCount} status=${event.status} workerDone=${event.workerDispatches} workerFailed=${event.workerFailures}`;
      if (event.status === 'error' && event.error) {
        line += ` error=${event.error.message}`;
      }
      return line;
    }
    case 'worker.round':
      return `worker.round name=${event.dispatch.name} kind=${event.dispatch.kind} roundKind=${event.dispatch.roundKind ?? 'instruction'} stopReason=${event.dispatch.promptResult.stopReason} path=${event.dispatch.worktree.path}`;
    case 'worker.failed':
      return `worker.failed name=${event.failure.name} kind=${event.failure.kind} error=${event.failure.error}`;
    case 'worker.process.stderr': {
      const name = event.workerName ? ` name=${event.workerName}` : '';
      return `worker.stderr${name} ${event.line}`;
    }
    case 'session.stop':
      return `session.stop reason=${event.stopReason}`;
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
      return '自律作業が一段落しました。追加の指示を入力するか、/exit で終了してください。';
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
