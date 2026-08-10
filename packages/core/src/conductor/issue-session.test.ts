import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
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
  const mockCreate = vi.fn();
  return { mockSend, mockClose, mockCreate };
});

let conductorTools: Record<string, SDKCustomTool> = {};

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
    mockCreate.mockReset();
    mockCreate.mockImplementation(async (options) => {
      conductorTools = options.customTools ?? {};
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
      };
    });
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
    expect(String(mockSend.mock.calls[0]![0])).toContain('作業フローの連鎖');
    expect(String(mockSend.mock.calls[1]![0])).toContain('continue with tests');
    expect(result.sendCount).toBe(2);
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

  it('waits for operator input after ask_human even when conductor finishes', async () => {
    mockSend
      .mockImplementationOnce(async () => {
        await conductorTools.ask_human!.execute({
          question: 'Should we continue?',
        });
        return {
          runId: 'run-1',
          status: 'finished',
          result: 'waiting for operator',
        };
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
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      onOperatorInput: (context) => {
        operatorCalls++;
        if (context.openQuestions.some((question) => question.id === 'inq-1')) {
          return 'yes, continue';
        }
        return undefined;
      },
    });

    expect(operatorCalls).toBeGreaterThanOrEqual(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const operatorMessage = String(mockSend.mock.calls[1]![0]);
    expect(operatorMessage).toContain('yes, continue');
    expect(operatorMessage).not.toMatch(/完了した worker/);
    expect(result.sendCount).toBe(2);
    expect(result.stopReason).toBe('completed');
    expect(
      result.openQuestions.some(
        (question) =>
          question.id === 'inq-1' &&
          question.status === 'answered' &&
          question.answer === 'yes, continue',
      ),
    ).toBe(true);
  });

  it('stops on conductor error without operator input', async () => {
    mockSend.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'error',
      error: { message: 'Model Blocked' },
    });

    const result = await runIssueSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: '/repo',
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
    expect(result.lastError?.message).toBe('Model Blocked');
  });

  it('continues after conductor error when operator input is available', async () => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'error',
        error: { message: 'Model Blocked' },
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'recovered',
      });

    let operatorCalls = 0;
    const result = await runIssueSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: '/repo',
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      continueOnConductorError: true,
      onOperatorInput: () => {
        operatorCalls++;
        return operatorCalls === 1 ? 'retry with another model' : undefined;
      },
    });

    expect(operatorCalls).toBeGreaterThanOrEqual(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(String(mockSend.mock.calls[1]![0])).toContain('retry with another model');
    expect(result.stopReason).toBe('completed');
    expect(result.lastResult).toBe('recovered');
  });

  it('stops on conductor error when onOperatorInput exists but continueOnConductorError is false', async () => {
    mockSend.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'error',
      error: { message: 'Model Blocked' },
    });

    const result = await runIssueSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: '/repo',
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      onOperatorInput: async () => undefined,
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
  });
});
