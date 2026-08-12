/** ink-testing-library 向けの端末キー入力シーケンス（Ink `parseKeypress` 互換）。 */
export const INK_TEST_KEYS = {
  pageUp: '\u001B[5~',
  pageDown: '\u001B[6~',
  end: '\u001B[F',
  home: '\u001B[H',
  /** xterm: Ctrl+PageUp */
  ctrlPageUp: '\u001B[5;5~',
} as const;

/** `stdin.write` 後に Ink の readable → useInput まで進める。 */
export async function flushInkStdin(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
