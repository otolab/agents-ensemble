import { describe, expect, it } from 'vitest';
import {
  advanceOperatorCommandSelection,
  getOperatorCommandSuggestionLines,
  getOperatorCommandSuggestions,
} from './operator-command-suggestions.js';

describe('operator command suggestions', () => {
  it('shows the catalog at slash and filters names by case-insensitive prefix', () => {
    expect(getOperatorCommandSuggestions('/').map(({ name }) => name)).toEqual([
      '/reconnect',
      '/exit',
      '/close',
    ]);
    expect(getOperatorCommandSuggestions('/ex').map(({ name }) => name)).toEqual([
      '/exit',
    ]);
    expect(getOperatorCommandSuggestions('/RE').map(({ name }) => name)).toEqual([
      '/reconnect',
    ]);
    expect(getOperatorCommandSuggestions('/RECO').map(({ name }) => name)).toEqual([
      '/reconnect',
    ]);
    expect(getOperatorCommandSuggestions('/cl').map(({ name }) => name)).toEqual([
      '/close',
    ]);
    expect(getOperatorCommandSuggestionLines('/cl', 80)[0]?.text).toContain(
      '/close — worktree を残してセッションを閉じる',
    );
  });

  it('only suggests for a single command token at the start of the input', () => {
    expect(getOperatorCommandSuggestions('  /ex  ').map(({ name }) => name)).toEqual([
      '/exit',
    ]);
    expect(getOperatorCommandSuggestions('\t/ex\t').map(({ name }) => name)).toEqual([
      '/exit',
    ]);
    expect(getOperatorCommandSuggestions('ordinary /exit')).toEqual([]);
    expect(getOperatorCommandSuggestions('/exit with arguments')).toEqual([]);
    expect(getOperatorCommandSuggestions('/ex\nmore text')).toEqual([]);
    expect(getOperatorCommandSuggestions('/ex\n')).toEqual([]);
    expect(getOperatorCommandSuggestions('/ex\r\n')).toEqual([]);
    expect(getOperatorCommandSuggestions('/ex\u2028')).toEqual([]);
    expect(getOperatorCommandSuggestions('/ex\u2029')).toEqual([]);
    expect(getOperatorCommandSuggestions('/unknown')).toEqual([]);
  });

  it('returns wrapped display rows for pane height and cursor calculations', () => {
    const rows = getOperatorCommandSuggestionLines('/ex', 12);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(({ text }) => text).join('\n')).toContain('/exit');
    expect(rows.map(({ text }) => text).join('')).toContain('セッションを終了');
  });

  it('selects the first candidate by default and keeps selection visible in wrapped rows', () => {
    const rows = getOperatorCommandSuggestionLines('/', 18);
    const selectedRows = rows.filter(({ isSelected }) => isSelected);
    expect(selectedRows[0]?.text).toMatch(/^› /u);
    expect(selectedRows).toHaveLength(
      getOperatorCommandSuggestionLines('/reconnect', 18).length,
    );
    expect(rows.find(({ isSelected }) => !isSelected)?.text).toMatch(/^ {2}/u);
  });

  it('moves selection without wrapping at either boundary', () => {
    expect(advanceOperatorCommandSelection(0, 'up', 3)).toBe(0);
    expect(advanceOperatorCommandSelection(0, 'down', 3)).toBe(1);
    expect(advanceOperatorCommandSelection(2, 'down', 3)).toBe(2);
    expect(advanceOperatorCommandSelection(2, 'up', 3)).toBe(1);
    expect(advanceOperatorCommandSelection(4, 'up', 0)).toBe(0);
  });
});
