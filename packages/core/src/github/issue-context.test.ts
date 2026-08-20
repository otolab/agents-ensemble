import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { fetchIssueContext } from './issue-context.js';
import type { GitHubClient } from './github-client.js';

describe('fetchIssueContext', () => {
  it('maps GitHub REST issue and comments', async () => {
    const githubClient: GitHubClient = {
      getIssue: vi.fn().mockResolvedValue({
        title: 'ACP bridge',
        body: 'Implement bridge',
        state: 'open',
        labels: [{ name: 'enhancement' }],
      }),
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: 'progress update',
          html_url: 'https://github.com/otolab/agents-ensemble/issues/3#issuecomment-1',
          user: { login: 'otolab' },
          created_at: '2026-08-07T00:00:00Z',
        },
      ]),
      searchLinkedPullRequests: vi.fn(),
      listPullRequestReviews: vi.fn(),
      listPullRequestReviewComments: vi.fn(),
      getStatusCheckRollup: vi.fn(),
    };

    const context = await fetchIssueContext(
      'https://github.com/otolab/agents-ensemble/issues/3',
      {
        ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
        githubClient,
      },
    );

    expect(context.issue.number).toBe(3);
    expect(context.title).toBe('ACP bridge');
    expect(context.labels).toEqual(['enhancement']);
    expect(context.comments).toHaveLength(1);
    expect(githubClient.getIssue).toHaveBeenCalledWith('otolab', 'agents-ensemble', 3);
    expect(githubClient.listIssueComments).toHaveBeenCalledWith(
      'otolab',
      'agents-ensemble',
      3,
    );
  });
});
