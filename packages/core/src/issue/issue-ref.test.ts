import { describe, expect, it } from 'vitest';
import { buildIssueUrl, parseIssueUrl } from './issue-ref.js';

describe('parseIssueUrl', () => {
  it('parses a GitHub issue URL', () => {
    expect(
      parseIssueUrl('https://github.com/otolab/agents-ensemble/issues/3'),
    ).toEqual({
      owner: 'otolab',
      repo: 'agents-ensemble',
      number: 3,
      url: 'https://github.com/otolab/agents-ensemble/issues/3',
    });
  });

  it('rejects invalid URLs', () => {
    expect(() => parseIssueUrl('not-a-url')).toThrow(/Invalid GitHub Issue URL/);
  });
});

describe('buildIssueUrl', () => {
  it('builds URL from parts', () => {
    expect(
      buildIssueUrl({ owner: 'otolab', repo: 'agents-ensemble', number: 1 }),
    ).toBe('https://github.com/otolab/agents-ensemble/issues/1');
  });
});
