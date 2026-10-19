import { describe, expect, it } from 'vitest';
import {
  getOperatorCommandSuggestionLines,
  getOperatorCommandSuggestions,
} from './operator-command-suggestions.js';

describe('operator command suggestions', () => {
  it('shows the catalog at slash and filters names by case-insensitive prefix', () => {
    expect(getOperatorCommandSuggestions('/').map(({ name }) => name)).toEqual([
      '/reconnect',
      '/exit',
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
    expect(rows.join('\n')).toContain('/exit');
    expect(rows.join('')).toContain('セッションを終了');
  });
});
