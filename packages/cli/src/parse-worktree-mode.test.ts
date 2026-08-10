import { describe, expect, it } from 'vitest';
import { parseWorktreeMode } from './parse-worktree-mode.js';

describe('parseWorktreeMode', () => {
  it('accepts isolated', () => {
    expect(parseWorktreeMode('isolated')).toBe('isolated');
  });

  it('accepts in-repo aliases', () => {
    expect(parseWorktreeMode('in-repo')).toBe('in_repo');
    expect(parseWorktreeMode('in_repo')).toBe('in_repo');
  });

  it('rejects unknown modes', () => {
    expect(() => parseWorktreeMode('shared')).toThrow(/Invalid --worktree/);
  });
});
