import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import { MAX_TURNS_OPEN_QUESTION_TEXT } from '../../src/escalation/enqueue-max-turns-question.js';
import type { Profile } from '../../src/profile/types.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import {
  expectNotLegacyFollowUpPrompt,
  extractYamlScalar,
} from './helpers/conductor-session-assertions.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const PING_PROFILE: Profile = {
  agents: {
    ping: { systemPrompt: PING_SYSTEM_PROMPT },
  },
  workers: [{ name: 'ping-1', kind: 'ping' }],
};

const { mockSend, mockClose, mockCreate } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  return { mockSend, mockClose, mockCreate };
});

let conductorTools: Record<string, SDKCustomTool> = {};

vi.mock('../../src/conductor/conductor-agent.js', () => ({
  ConductorAgent: {
    create: mockCreate,
    resume: mockCreate,
  },
}));

describe('open question / operator flow integration', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Integration open question',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue(TEST_WORKTREE);

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

  it('delivers operator answer via event queue after ask_human (not follow-up prompt)', async () => {
    mockSend
      .mockImplementationOnce(async () => {
        await conductorTools.ask_human!.execute({
          question: 'Proceed with deploy?',
        });
        return {
          runId: 'run-1',
          status: 'finished',
          result: 'registered open question',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'conductor-ok',
      });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      onOperatorInput: (context) => {
        if (context.openQuestions.some((question) => question.id === 'inq-1')) {
          return 'yes, deploy';
        }
        return undefined;
      },
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(String(mockSend.mock.calls[0]![0])).toContain('Integration open question');
    const operatorMessage = String(mockSend.mock.calls[1]![0]);
    expect(operatorMessage).toContain('yes, deploy');
    expectNotLegacyFollowUpPrompt(operatorMessage);

    expect(result.stopReason).toBe('completed');
    expect(
      result.openQuestions.find((question) => question.id === 'inq-1')?.status,
    ).toBe('answered');
  });

  it('resumes after max_turns open question via operator.message event', async () => {
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

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: { workers: [] },
      maxTurns: 1,
      permissionPipeline: new PermissionPipeline({}),
      onOperatorInput: (context) => {
        if (
          context.openQuestions.some((question) => question.source === 'max_turns')
        ) {
          return 'continue with tests';
        }
        return undefined;
      },
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expectNotLegacyFollowUpPrompt(String(mockSend.mock.calls[1]![0]));
    expect(result.openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'max_turns',
          question: MAX_TURNS_OPEN_QUESTION_TEXT,
          status: 'answered',
          answer: 'continue with tests',
        }),
      ]),
    );
  });

  it('sends permission.pending event then resolves via resolve_permission', async () => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
    });

    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount++;
      if (sendCount === 1) {
        return { runId: 'run-1', status: 'finished', result: 'init' };
      }
      if (message.includes('permission 判断待ち')) {
        const requestId = extractYamlScalar(message, 'id');
        expect(requestId).toBeTruthy();
        await conductorTools.resolve_permission!.execute({
          requestId: requestId!,
          decision: 'allow',
        });
        return { runId: 'run-2', status: 'finished', result: 'permission resolved' };
      }
      if (message.includes('worker 完了')) {
        return { runId: 'run-3', status: 'finished', result: 'conductor-ok' };
      }
      return { runId: `run-${sendCount}`, status: 'finished', result: 'ok' };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: PING_PROFILE,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({
        policy: { allowTools: [], allowReadOnlyTools: false },
      }),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(messages[0]).toContain('Integration open question');
    expect(messages[1]).toContain('permission 判断待ち');
    expect(messages[2]).toContain('worker 完了');
    expect(result.workerDispatches).toHaveLength(1);
    expect(result.workerFailures).toHaveLength(0);
    expect(result.stopReason).toBe('completed');
  });
});
