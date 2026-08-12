import type { SessionLogEvent } from '@agents-ensemble/core';
import { stdout } from 'node:process';
import { createDialogueSink } from '../session-sinks.js';
import type { SessionDisplayBackend } from './session-display-backend.js';

export interface StringSessionDisplayBackendOptions {
  /** デフォルト: `process.stdout.write` */
  writeStdout?: (text: string) => void;
}

function isDialogueEvent(
  event: SessionLogEvent,
): event is Extract<SessionLogEvent, { type: 'operator.input' | 'conductor.send' }> {
  return event.type === 'operator.input' || event.type === 'conductor.send';
}

/** TTY 向け: `createDialogueSink` で stdout 対話を出力。state は TUI 用に reducer が更新する。 */
export function createStringSessionDisplayBackend(
  options: StringSessionDisplayBackendOptions = {},
): SessionDisplayBackend {
  const writeStdout = options.writeStdout ?? ((text) => stdout.write(text));
  const dialogueSink = createDialogueSink({ writeStdout });

  return {
    render(_state, _previousState, event) {
      if (isDialogueEvent(event)) {
        dialogueSink(event);
      }
    },
  };
}
