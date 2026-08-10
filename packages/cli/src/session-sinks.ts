import type { SessionLogEvent, SessionLogSink } from '@agents-ensemble/core';
import { stdout } from 'node:process';

/** harness テレメトリ（開発者向け）。stderr に統一 prefix で出す。 */
export function createHarnessSink(): SessionLogSink {
  return (event) => {
    switch (event.type) {
      case 'harness.worktree':
        console.error(
          `[harness] worktree path=${event.path} branch=${event.branch} mode=${event.mode}`,
        );
        break;
      case 'operator.input':
        console.error(
          `[harness] operator.input turn=${event.conductorTurn} bytes=${event.text.length}`,
        );
        break;
      case 'conductor.send':
        console.error(
          `[harness] conductor.send n=${event.sendCount} status=${event.status} workerDone=${event.workerDispatches} workerFailed=${event.workerFailures}`,
        );
        if (event.status === 'error' && event.error) {
          console.error(`[harness] conductor.error ${event.error.message}`);
        }
        break;
      case 'worker.round':
        console.error(
          `[harness] worker.round name=${event.dispatch.name} kind=${event.dispatch.kind} stopReason=${event.dispatch.promptResult.stopReason} path=${event.dispatch.worktree.path}`,
        );
        break;
      case 'worker.failed':
        console.error(
          `[harness] worker.failed name=${event.failure.name} kind=${event.failure.kind} error=${event.failure.error}`,
        );
        break;
      case 'session.stop':
        console.error(`[harness] session.stop reason=${event.stopReason}`);
        break;
    }
  };
}

/** オペレータ↔conductor の見える会話。TTY 時のみ有効にすること。 */
export function createDialogueSink(): SessionLogSink {
  return (event) => {
    switch (event.type) {
      case 'operator.input':
        stdout.write(`\noperator> ${event.text}\n`);
        break;
      case 'conductor.send':
        if (event.status === 'finished' && event.result?.trim()) {
          stdout.write(`\nconductor> ${event.result.trim()}\n`);
        } else if (event.status === 'error') {
          const detail = event.error?.message ?? 'unknown error';
          stdout.write(
            `\nconductor> 応答を生成できませんでした（${detail}）。\n別の聞き方で再入力してください。\n`,
          );
        }
        break;
      case 'harness.worktree':
      case 'worker.round':
      case 'worker.failed':
      case 'session.stop':
        break;
    }
  };
}
