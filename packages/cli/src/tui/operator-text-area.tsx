import React, { useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { TextArea, type TKeybindings, type TLinePrefixProps } from 'react-ink-textarea';
import { computeOperatorInputLayout } from './operator-input-layout.js';
import { INPUT_PANE_PROMPT_COLOR } from './tui-layout-constants.js';

export interface OperatorTextAreaProps {
  readonly value: string;
  readonly focus?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  /** ペイン内コンテンツ幅（折り返し計算用）。 */
  readonly contentWidth: number;
  /** 1 行目先頭のプロンプト（例: `> `）。 */
  readonly promptPrefix?: string;
  /** 入力欄に表示できる最大行数（末尾追従）。 */
  readonly maxDisplayLines: number;
  readonly onDisplayLineCountChange?: (lineCount: number) => void;
  /** Slash 候補表示中は上下矢印を候補選択へ渡す。 */
  readonly commandSuggestionsActive?: boolean;
  /** TextArea の Tab callback。 */
  readonly onTab?: (shift: boolean) => void;
  /** 候補補完後の caret 位置。 */
  readonly cursorPosition?: [number, number];
  readonly onCursorChange?: (position: [number, number]) => void;
  /**
   * Ink 出力原点からの入力欄先頭行位置。IME 変換窓を実カーソルに合わせる。
   * `x` はプロンプト直前の列（`linePrefix` 幅は TextArea 側で加算）、`y` は表示先頭行。
   */
  readonly cursorStart?: { readonly x?: number; readonly y: number };
}

/**
 * `react-ink-textarea` ベースのオペレータ入力欄。
 * IME 物理カーソルはフォーク版 TextArea の `cursorStart` + 内部 visual row に委譲する。
 */
export function OperatorTextArea({
  value,
  focus = true,
  onChange,
  onSubmit,
  contentWidth,
  promptPrefix = '',
  maxDisplayLines,
  onDisplayLineCountChange,
  commandSuggestionsActive = false,
  onTab,
  cursorPosition,
  onCursorChange,
  cursorStart,
}: OperatorTextAreaProps) {
  const promptWidth = stringWidth(promptPrefix);

  const layout = useMemo(
    () => computeOperatorInputLayout(value, contentWidth, promptWidth),
    [value, contentWidth, promptWidth],
  );

  useEffect(() => {
    onDisplayLineCountChange?.(layout.displayLines.length);
  }, [layout.displayLines.length, onDisplayLineCountChange]);

  const linePrefix = useCallback(
    ({ lineNumber, isContinuationLine }: TLinePrefixProps) => {
      if (lineNumber === 0 && !isContinuationLine && promptPrefix.length > 0) {
        return <Text color={INPUT_PANE_PROMPT_COLOR}>{promptPrefix}</Text>;
      }
      return null;
    },
    [promptPrefix],
  );

  const textAreaCursorStart =
    focus && cursorStart !== undefined
      ? {
          x: (cursorStart.x ?? 0) - promptWidth,
          y: cursorStart.y,
        }
      : undefined;
  const keybindings: TKeybindings | undefined = commandSuggestionsActive
    ? { Up: false, Down: false }
    : undefined;

  return (
    <Box width={contentWidth} flexDirection="column">
      <TextArea
        focus={focus}
        value={value}
        onChange={onChange}
        onSubmit={(submitted) => onSubmit?.(submitted)}
        onTab={onTab}
        keybindings={keybindings}
        cursorPosition={cursorPosition}
        onCursorChange={onCursorChange}
        linePrefix={promptPrefix ? linePrefix : undefined}
        viewportLines={maxDisplayLines}
        initialLineCount={1}
        cursorStart={textAreaCursorStart}
      />
    </Box>
  );
}
