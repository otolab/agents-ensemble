import { describe, expect, it } from 'vitest';
import {
  classifyGitHubMonitorError,
  safeUpperString,
} from './github-monitor-error.js';

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

describe('classifyGitHubMonitorError', () => {
  it('classifies fetch failures as retryable network errors', () => {
    expect(classifyGitHubMonitorError(new TypeError('fetch failed'))).toEqual({
      cause: 'network',
      retryable: true,
      message: 'fetch failed',
    });
  });

  it('keeps unrelated TypeErrors non-retryable parse errors', () => {
    expect(classifyGitHubMonitorError(new TypeError('invalid response shape'))).toEqual({
      cause: 'parse',
      retryable: false,
      message: 'invalid response shape',
    });
  });
});
