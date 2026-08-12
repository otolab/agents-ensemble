import type { SessionLogEvent } from '@agents-ensemble/core';
import { stdout } from 'node:process';
import type { SessionDisplayBackend } from './session-display-backend.js';
import type { SessionDisplayState } from './session-display-state.js';

export interface StringSessionDisplayBackendOptions {
  /** デフォルト: `process.stdout.write` */
  writeStdout?: (text: string) => void;
}

/** TTY 向け: 現行 DialogueSink 相当の stdout 出力。state は TUI 用に reducer が更新する。 */
export function createStringSessionDisplayBackend(
  options: StringSessionDisplayBackendOptions = {},
): SessionDisplayBackend {
  const writeStdout = options.writeStdout ?? ((text) => stdout.write(text));

  return {
    render(_state, _previousState, event) {
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
        default:
          break;
      }
    },
  };
}
