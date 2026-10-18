import { OPERATOR_COMMANDS } from '@agents-ensemble/core';
import { wrapTextToWidth } from './wrap-text-to-width.js';

/** 入力全体が単一行のコマンド名 prefix のときだけ候補を返す。 */
export function getOperatorCommandSuggestions(input: string) {
  const match = /^[\t ]*\/([^\s]*)[\t ]*$/u.exec(input);
  if (!match) {
    return [];
  }

  const prefix = `/${match[1]}`.toLowerCase();
  return OPERATOR_COMMANDS.filter((command) =>
    command.name.toLowerCase().startsWith(prefix),
  );
}

/** pane 内に表示する候補行。候補の折り返しも入力ペインの高さ計算と共有する。 */
export function getOperatorCommandSuggestionLines(
  input: string,
  contentWidth: number,
): string[] {
  return getOperatorCommandSuggestions(input).flatMap((command) =>
    wrapTextToWidth(`${command.name} — ${command.description}`, contentWidth),
  );
}
