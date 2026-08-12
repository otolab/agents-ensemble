import type { SessionLogSink } from '@agents-ensemble/core';
import { isConductorAuthError } from '@agents-ensemble/core';
import { stdout } from 'node:process';
import {
  formatHarnessLogBody,
  formatObservationStderrLine,
} from './session-log-lines.js';

export interface HarnessSinkOptions {
  /** デフォルト: `console.error` */
  writeStderr?: (message: string) => void;
}

/** harness テレメトリ（開発者向け）。stderr に統一 prefix で出す。 */
export function createHarnessSink(options: HarnessSinkOptions = {}): SessionLogSink {
  const writeStderr = options.writeStderr ?? ((message) => console.error(message));

  return (event) => {
    const body = formatHarnessLogBody(event);
    if (body) {
      writeStderr(`[harness] ${body}`);
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
          if (isConductorAuthError(detail)) {
            writeStdout(
              '\nconductor> 認証エラーが発生しました。stderr の [auth] 手順に従って再認証してください。\n',
            );
          } else {
            writeStdout(
              `\nconductor> 応答を生成できませんでした（${detail}）。\n別の聞き方で再入力してください。\n`,
            );
          }
        }
        break;
      case 'harness.worktree':
      case 'harness.worktree.removed':
      case 'harness.worktree.remove_skipped':
      case 'harness.worktree.remove_failed':
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
      case 'conductor.auth.recovery':
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
    const line = formatObservationStderrLine(event);
    if (line) {
      writeStderr(line);
    }
  };
}
