import type { SessionDisplayBackend } from './session-display-backend.js';
import { createStringSessionDisplayBackend } from './string-session-display-backend.js';
import type { StringSessionDisplayBackendOptions } from './string-session-display-backend.js';
import { createStubSessionDisplayBackend } from './stub-session-display-backend.js';

export interface SelectSessionDisplayBackendOptions
  extends StringSessionDisplayBackendOptions {
  interactive: boolean;
}

const noopBackend: SessionDisplayBackend = {
  render() {},
};

/** interactive / 非 TTY に応じて表示 backend を選ぶ。非 interactive は no-op（harness / observation のみ）。 */
export function selectSessionDisplayBackend(
  options: SelectSessionDisplayBackendOptions,
): SessionDisplayBackend {
  if (options.interactive) {
    return createStringSessionDisplayBackend({
      writeStdout: options.writeStdout,
    });
  }
  return noopBackend;
}

export { createStubSessionDisplayBackend, createStringSessionDisplayBackend };
