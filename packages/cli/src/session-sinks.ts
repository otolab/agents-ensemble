import type { SessionLogSink } from '@agents-ensemble/core';
import { stdout } from 'node:process';
import {
  formatHarnessLogBody,
  formatObservationStderrLine,
} from './session-log-lines.js';
import { renderInlineMarkdownToAnsi } from './inline-markdown.js';

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
      writeStderr(renderInlineMarkdownToAnsi(`[harness] ${body}`));
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
        writeStdout(`\noperator> ${renderInlineMarkdownToAnsi(event.text)}\n`);
        break;
      case 'conductor.send':
        if (event.status === 'finished' && event.result?.trim()) {
          writeStdout(
            `\nconductor> ${renderInlineMarkdownToAnsi(event.result.trim())}\n`,
          );
        }
        break;
      case 'harness.worktree':
      case 'harness.worktree.removed':
      case 'harness.worktree.remove_skipped':
      case 'harness.worktree.remove_failed':
      case 'harness.worker.prompt.started':
      case 'harness.worker.prompt.completed':
      case 'harness.worker.prompt.failed':
      case 'harness.worker.state':
      case 'harness.session.workers':
      case 'worker.round':
      case 'worker.failed':
      case 'worker.process.stderr':
      case 'session.stop':
      case 'open.question.enqueued':
      case 'escalation.recorded':
      case 'session.worktree.notice':
      case 'session.continue':
      case 'session.post_loop_wait':
      case 'conductor.dispatch_hold':
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
      writeStderr(renderInlineMarkdownToAnsi(line));
    }
  };
}
