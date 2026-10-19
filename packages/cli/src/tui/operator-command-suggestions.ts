import { OPERATOR_COMMANDS } from '@agents-ensemble/core';
import { wrapTextToWidth } from './wrap-text-to-width.js';

export interface OperatorCommandSuggestionLine {
  readonly id: string;
  readonly text: string;
  readonly isSelected: boolean;
}

/** 入力全体が単一行のコマンド名 prefix のときだけ候補を返す。 */
export function getOperatorCommandSuggestions(input: string) {
  if (/[\r\n\u2028\u2029]/u.test(input)) {
    return [];
  }

  const match = /^[\t ]*\/([^\s]*)[\t ]*$/u.exec(input);
  if (!match) {
    return [];
  }

  const prefix = `/${match[1]}`.toLowerCase();
  return OPERATOR_COMMANDS.filter((command) =>
    command.name.toLowerCase().startsWith(prefix),
  );
}

/** 候補 index を上下へ進める。リスト端では循環せず、その場に留まる。 */
export function advanceOperatorCommandSelection(
  selectedIndex: number,
  direction: 'up' | 'down',
  suggestionCount: number,
): number {
  if (suggestionCount <= 0) {
    return 0;
  }

  const currentIndex = Math.min(
    Math.max(selectedIndex, 0),
    suggestionCount - 1,
  );
  const offset = direction === 'up' ? -1 : 1;
  return Math.min(Math.max(currentIndex + offset, 0), suggestionCount - 1);
}

/** pane 内に表示する候補行。候補の折り返しも入力ペインの高さ計算と共有する。 */
export function getOperatorCommandSuggestionLines(
  input: string,
  contentWidth: number,
  selectedIndex = 0,
): OperatorCommandSuggestionLine[] {
  const width = Math.max(1, Math.floor(contentWidth));
  const markerWidth = width >= 3 ? 2 : width >= 2 ? 1 : 0;
  const textWidth = Math.max(1, width - markerWidth);
  const unselectedMarker = ' '.repeat(markerWidth);
  const selectedMarker = markerWidth === 2 ? '› ' : markerWidth === 1 ? '›' : '';

  return getOperatorCommandSuggestions(input).flatMap((command, commandIndex) => {
    const isSelected = commandIndex === selectedIndex;
    return wrapTextToWidth(
      `${command.name} — ${command.description}`,
      textWidth,
    ).map((line, lineIndex) => ({
      id: `${command.id}-${lineIndex}`,
      text: `${isSelected && lineIndex === 0 ? selectedMarker : unselectedMarker}${line}`,
      isSelected,
    }));
  });
}
