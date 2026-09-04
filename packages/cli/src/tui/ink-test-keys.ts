/** ink-testing-library 向けの端末キー入力シーケンス（Ink `parseKeypress` 互換）。 */
export const INK_TEST_KEYS = {
  /** Readline Emacs: beginning-of-line */
  ctrlA: '\x01',
  /** Readline Emacs: end-of-line */
  ctrlE: '\x05',
  /** Readline Emacs: forward-char */
  ctrlF: '\x06',
  /** Readline Emacs: backward-char */
  ctrlB: '\x02',
  /** Readline Emacs: delete-char */
  ctrlD: '\x04',
  /** Textarea visual row up (same direction as Up) */
  ctrlP: '\x10',
  /** Textarea visual row down (same direction as Down) */
  ctrlN: '\x0e',
  /** Readline Emacs: kill-line */
  ctrlK: '\x0b',
  /** Readline Emacs: unix-line-discard */
  ctrlU: '\x15',
  /** Readline Emacs: unix-word-rubout */
  ctrlW: '\x17',
  /** Readline Emacs: yank */
  ctrlY: '\x19',
  /** Readline Emacs: forward-word (ESC f) */
  altF: '\x1bf',
  /** Readline Emacs: backward-word (ESC b) */
  altB: '\x1bb',
  /** Readline Emacs: yank-pop (ESC y) */
  altY: '\x1by',
  pageUp: '\u001B[5~',
  pageDown: '\u001B[6~',
  end: '\u001B[F',
  home: '\u001B[H',
  leftArrow: '\u001B[D',
  rightArrow: '\u001B[C',
  upArrow: '\u001B[A',
  downArrow: '\u001B[B',
  /** xterm modifyOtherKeys: Shift+Enter */
  shiftEnter: '\x1b[27;2;13~',
  /** xterm: Ctrl+PageUp */
  ctrlPageUp: '\u001B[5;5~',
  /** xterm: Shift+Up */
  shiftUpArrow: '\u001B[1;2A',
  /** xterm: Shift+Down */
  shiftDownArrow: '\u001B[1;2B',
} as const;

/** `stdin.write` 後に Ink の readable → useInput まで進める。 */
export async function flushInkStdin(delayMs = 50): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
