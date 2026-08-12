import { describe, expect, it } from 'vitest';
import {
  formatIssueContextForPrompt,
  formatIssueContextYaml,
} from './format-issue-context-prompt.js';
import type { IssueContext } from './issue-context.js';

const SAMPLE_CONTEXT: IssueContext = {
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 37,
    url: 'https://github.com/org/repo/issues/37',
  },
  title: 'Phase 4: Issue injection',
  body: 'Inject title and body into conductor send.',
  state: 'OPEN',
  labels: ['enhancement'],
  comments: [
    {
      author: 'otolab',
      body: 'Use markdown sections and YAML metadata.',
      createdAt: '2026-08-07T00:00:00Z',
    },
  ],
};

describe('formatIssueContextForPrompt', () => {
  it('renders description and comments as markdown sections with yaml metadata', () => {
    const prompt = formatIssueContextForPrompt(SAMPLE_CONTEXT);

    expect(prompt).toContain('## Description');
    expect(prompt).toContain('Inject title and body into conductor send.');
    expect(prompt).toContain('## Comments');
    expect(prompt).toContain('### @otolab (2026-08-07T00:00:00Z)');
    expect(prompt).toContain('Use markdown sections and YAML metadata.');
    expect(prompt).toContain('```yaml');
    expect(prompt).toContain('# issue.context');
    expect(prompt).not.toContain('https://github.com/org/repo/issues/37');
  });

  it('shows (empty) when body is blank', () => {
    const prompt = formatIssueContextForPrompt({
      ...SAMPLE_CONTEXT,
      body: '   ',
      comments: [],
    });

    expect(prompt).toContain('(empty)');
  });
});

describe('formatIssueContextYaml', () => {
  it('includes title, body, and comments in yaml', () => {
    const yaml = formatIssueContextYaml(SAMPLE_CONTEXT);

    expect(yaml).toContain('Phase 4: Issue injection');
    expect(yaml).toContain('state: OPEN');
    expect(yaml).toContain('enhancement');
    expect(yaml).toContain('Use markdown sections and YAML metadata.');
    expect(yaml).toContain('author: otolab');
    expect(yaml).not.toContain('Inject title and body into conductor send.');
  });
});
