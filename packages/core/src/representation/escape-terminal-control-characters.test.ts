import { describe, expect, it } from 'vitest';
import { escapeTerminalControlCharacters } from './escape-terminal-control-characters.js';

describe('escapeTerminalControlCharacters', () => {
  it('makes terminal controls and bidi formatting visible while preserving line breaks', () => {
    const input =
      'line 1\n\tstatus\u000d\u001b[2J\u009b\u202e\u2066\u2069\u200e\u200f\u061c\u2028\u2029';
    const escaped = escapeTerminalControlCharacters(input, {
      preserveNewlines: true,
    });

    expect(escaped).toBe(
      'line 1\n\\tstatus\\u000d\\u001b[2J\\u009b\\u202e\\u2066\\u2069\\u200e\\u200f\\u061c\\u2028\\u2029',
    );
    expect(escaped).not.toContain('\u001b');
    expect(escaped).not.toContain('\u009b');
    expect(escaped).not.toContain('\u202e');
    expect(escaped).not.toContain('\u2066');
    expect(escaped).not.toContain('\u2069');
    expect(escaped).not.toContain('\u200e');
    expect(escaped).not.toContain('\u200f');
    expect(escaped).not.toContain('\u061c');
    expect(escaped).not.toContain('\u2028');
    expect(escaped).not.toContain('\u2029');
  });

  it('escapes newlines by default so untrusted labels stay on one line', () => {
    expect(escapeTerminalControlCharacters('error\nforged\rstatus')).toBe(
      'error\\u000aforged\\u000dstatus',
    );
  });
});
