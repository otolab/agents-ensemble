import type { SessionLogEvent, SessionLogSink } from '@agents-ensemble/core';
import { stdout } from 'node:process';

export interface HarnessSinkOptions {
  /** デフォルト: `console.error` */
  writeStderr?: (message: string) => void;
}

/** harness テレメトリ（開発者向け）。stderr に統一 prefix で出す。 */
export function createHarnessSink(options: HarnessSinkOptions = {}): SessionLogSink {
  const writeStderr = options.writeStderr ?? ((message) => console.error(message));

  return (event) => {
    switch (event.type) {
      case 'harness.worktree':
        writeStderr(
          `[harness] worktree path=${event.path} branch=${event.branch} mode=${event.mode}`,
        );
        break;
      case 'harness.worker.bootstrap.started':
        writeStderr(
          `[harness] worker.bootstrap.started name=${event.name} kind=${event.kind}`,
        );
        break;
      case 'harness.worker.bootstrap.completed':
        writeStderr(
          `[harness] worker.bootstrap.completed name=${event.name} kind=${event.kind} stopReason=${event.stopReason}`,
        );
        break;
      case 'harness.worker.bootstrap.failed':
        writeStderr(
          `[harness] worker.bootstrap.failed name=${event.name} kind=${event.kind} error=${event.error}`,
        );
        break;
      case 'operator.input':
        writeStderr(
          `[harness] operator.input turn=${event.conductorTurn} bytes=${event.text.length}`,
        );
        break;
      case 'conductor.send':
        writeStderr(
          `[harness] conductor.send n=${event.sendCount} status=${event.status} workerDone=${event.workerDispatches} workerFailed=${event.workerFailures}`,
        );
        if (event.status === 'error' && event.error) {
          writeStderr(`[harness] conductor.error ${event.error.message}`);
        }
        break;
      case 'worker.round':
        writeStderr(
          `[harness] worker.round name=${event.dispatch.name} kind=${event.dispatch.kind} roundKind=${event.dispatch.roundKind ?? 'instruction'} stopReason=${event.dispatch.promptResult.stopReason} path=${event.dispatch.worktree.path}`,
        );
        break;
      case 'worker.failed':
        writeStderr(
          `[harness] worker.failed name=${event.failure.name} kind=${event.failure.kind} error=${event.failure.error}`,
        );
        break;
      case 'worker.process.stderr': {
        const name = event.workerName ? ` name=${event.workerName}` : '';
        writeStderr(`[harness] worker.stderr${name} ${event.line}`);
        break;
      }
      case 'session.stop':
        writeStderr(`[harness] session.stop reason=${event.stopReason}`);
        break;
      case 'open.question.enqueued':
      case 'escalation.recorded':
      case 'session.worktree.notice':
      case 'session.continue':
      case 'session.post_loop_wait':
        break;
    }
  };
}

export interface DialogueSinkOptions {
  /** デフォルト: `process.stdout.write` */
  writeStdout?: (text: string) => void;
}

/** オペレータ↔conductor の見える会話。TTY 時のみ有効にすること。 */
export function createDialogueSink(options: DialogueSinkOptions = {}): SessionLogSink {
  const writeStdout = options.writeStdout ?? ((text) => stdout.write(text));

  return (event) => {
    switch (event.type) {
      case 'operator.input':
        writeStdout(`\noperator> ${event.text}\n`);
        break;
      case 'conductor.send':
        if (event.status === 'finished' && event.result?.trim()) {
          writeStdout(`\nconductor> ${event.result.trim()}\n`);
        } else if (event.status === 'error') {
          const detail = event.error?.message ?? 'unknown error';
          writeStdout(
            `\nconductor> 応答を生成できませんでした（${detail}）。\n別の聞き方で再入力してください。\n`,
          );
        }
        break;
      case 'harness.worktree':
      case 'harness.worker.bootstrap.started':
      case 'harness.worker.bootstrap.completed':
      case 'harness.worker.bootstrap.failed':
      case 'worker.round':
      case 'worker.failed':
      case 'worker.process.stderr':
      case 'session.stop':
      case 'open.question.enqueued':
      case 'escalation.recorded':
      case 'session.worktree.notice':
      case 'session.continue':
      case 'session.post_loop_wait':
        break;
    }
  };
}

export interface ObservationSinkOptions {
  /** デフォルト: `console.error` */
  writeStderr?: (message: string) => void;
}

/** セッション観測（open question / エスカレーション / CLI 通知）。stderr に prefix 付きで出す。 */
export function createObservationSink(
  options: ObservationSinkOptions = {},
): SessionLogSink {
  const writeStderr = options.writeStderr ?? ((message) => console.error(message));

  return (event) => {
    switch (event.type) {
      case 'open.question.enqueued':
        writeStderr(
          `[open question] ${event.question.id} [${event.question.responseType}] ${event.question.question}`,
        );
        break;
      case 'escalation.recorded':
        writeStderr(
          `[operator answer] ${event.record.question} → ${event.record.answer}`,
        );
        break;
      case 'session.worktree.notice':
        writeStderr(
          '[worktree] 特別モード: メイン worktree で直接作業します（isolated worktree は作りません）',
        );
        break;
      case 'session.continue':
        writeStderr(
          `[continue] resuming session: conductorAgentId=${event.conductorAgentId}`,
        );
        break;
      case 'session.post_loop_wait':
        writeStderr(
          '\n自律作業が一段落しました。追加の指示を入力するか、/exit で終了してください。\n',
        );
        break;
      case 'harness.worktree':
      case 'harness.worker.bootstrap.started':
      case 'harness.worker.bootstrap.completed':
      case 'harness.worker.bootstrap.failed':
      case 'operator.input':
      case 'conductor.send':
      case 'worker.round':
      case 'worker.failed':
      case 'worker.process.stderr':
      case 'session.stop':
        break;
    }
  };
}
