import { describe, expect, it } from 'vitest';
import { safeUpperString } from './github-monitor-error.js';

describe('safeUpperString', () => {
  it('uppercases non-empty strings', () => {
    expect(safeUpperString('pending', 'FALLBACK')).toBe('PENDING');
  });

  it('returns fallback for non-string values', () => {
    expect(safeUpperString(0, 'UNKNOWN')).toBe('UNKNOWN');
    expect(safeUpperString(null, 'UNKNOWN')).toBe('UNKNOWN');
    expect(safeUpperString(undefined, 'UNKNOWN')).toBe('UNKNOWN');
    expect(safeUpperString({}, 'UNKNOWN')).toBe('UNKNOWN');
  });

  it('returns fallback for empty strings', () => {
    expect(safeUpperString('', 'UNKNOWN')).toBe('UNKNOWN');
  });
});
