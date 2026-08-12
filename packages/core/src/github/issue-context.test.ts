import { describe, expect, it, vi } from 'vitest';
import { fetchIssueContext } from './issue-context.js';
import * as runGhModule from './run-gh.js';

describe('fetchIssueContext', () => {
  it('parses gh issue view JSON', async () => {
    vi.spyOn(runGhModule, 'runGh').mockResolvedValue(
      JSON.stringify({
        title: 'ACP bridge',
        body: 'Implement bridge',
        state: 'OPEN',
        labels: [{ name: 'enhancement' }],
        comments: [
          {
            author: { login: 'otolab' },
            body: 'progress update',
            createdAt: '2026-08-07T00:00:00Z',
          },
        ],
      }),
    );

    const context = await fetchIssueContext(
      'https://github.com/otolab/agents-ensemble/issues/3',
    );

    expect(context.issue.number).toBe(3);
    expect(context.title).toBe('ACP bridge');
    expect(context.labels).toEqual(['enhancement']);
    expect(context.comments).toHaveLength(1);
    expect(runGhModule.runGh).toHaveBeenCalledWith([
      'issue',
      'view',
      'https://github.com/otolab/agents-ensemble/issues/3',
      '--json',
      'title,body,state,labels,comments',
    ]);

    vi.restoreAllMocks();
  });
});
