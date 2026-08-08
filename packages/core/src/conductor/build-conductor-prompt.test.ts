import { describe, expect, it } from 'vitest';
import { buildConductorPrompt } from './build-conductor-prompt.js';
import type { IssueContext } from '../github/issue-context.js';

const sampleContext: IssueContext = {
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 1,
    url: 'https://github.com/org/repo/issues/1',
  },
  title: 'Test issue',
  body: 'Do the thing',
  state: 'OPEN',
  labels: ['enhancement'],
  comments: [],
};

describe('buildConductorPrompt', () => {
  it('includes issue context and dispatch guidance', () => {
    const prompt = buildConductorPrompt({
      issueContext: sampleContext,
      repoRoot: '/tmp/repo',
    });

    expect(prompt).toContain('conductor');
    expect(prompt).toContain('プロファイル');
    expect(prompt).toContain('Do the thing');
    expect(prompt).toContain('/tmp/repo');
  });

  it('renders materials in Prepared Materials section', () => {
    const prompt = buildConductorPrompt({
      issueContext: sampleContext,
      repoRoot: '/tmp/repo',
      materials: [
        {
          id: 'profile',
          title: 'Workflow Profile',
          content: 'worker → reviewer → close',
        },
      ],
    });

    expect(prompt).toContain('Workflow Profile');
    expect(prompt).toContain('worker → reviewer → close');
  });
});
