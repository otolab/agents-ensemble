import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as issueContextModule from '../github/issue-context.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { MAX_TURNS_OPEN_QUESTION_TEXT } from '../escalation/enqueue-max-turns-question.js';
import { runIssueSession } from './issue-session.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

const { mockSend, mockClose, mockCreate } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn().mockResolvedValue({
    agentId: 'agent-test',
    send: mockSend,
    close: mockClose,
  });
  return { mockSend, mockClose, mockCreate };
});

vi.mock('./conductor-agent.js', () => ({
  ConductorAgent: {
    create: mockCreate,
    resume: mockCreate,
  },
}));

describe('runIssueSession', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Test',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enqueues max-turns open question and resumes after operator input', async () => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'still working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'conductor-ok',
      });

    let operatorCalls = 0;
    const result = await runIssueSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: '/repo',
      profile: { workers: [] },
      maxTurns: 1,
      permissionPipeline: new PermissionPipeline({}),
      onOperatorInput: (context) => {
        operatorCalls++;
        const maxTurnsQuestion = context.openQuestions.find(
          (question) => question.source === 'max_turns',
        );
        if (maxTurnsQuestion) {
          return 'continue with tests';
        }
        return undefined;
      },
    });

    expect(operatorCalls).toBeGreaterThanOrEqual(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(result.turnCount).toBe(2);
    expect(result.stopReason).toBe('completed');
    expect(result.lastResult).toBe('conductor-ok');
    expect(
      result.openQuestions.some(
        (question) =>
          question.source === 'max_turns' &&
          question.question === MAX_TURNS_OPEN_QUESTION_TEXT &&
          question.status === 'answered',
      ),
    ).toBe(true);
  });
});
