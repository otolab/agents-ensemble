import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import yaml from 'js-yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import type { Profile } from '../../src/profile/types.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import { createMockConductorGetUsage } from '../../src/testing/mock-conductor-get-usage.js';
import {
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const TWO_WORKER_PROFILE: Profile = {
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
    fail: { prompt: { instructions: ['fail agent'] } },
  },
  workers: [
    { name: 'ping-1', kind: 'ping' },
    { name: 'fail-1', kind: 'fail' },
  ],
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

function parseYamlBlock(text: string): Record<string, unknown> {
  const match = text.match(/```yaml\n# [^\n]+\n([\s\S]*?)```/);
  if (!match?.[1]) {
    throw new Error(`YAML block not found in: ${text.slice(0, 200)}`);
  }
  return yaml.load(match[1]) as Record<string, unknown>;
}

describe('worker status operator integration', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Worker status test',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);

    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreate.mockImplementation(async (options) => {
      conductorTools = options.customTools ?? {};
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('list_workers aligns runningCount and reports attach/failure for operator status', async () => {
    let connectCount = 0;
    const bridge = await createInProcessAcpBridge(async ({ notify, sessionId }) => {
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pong' },
        },
      });
      return { stopReason: 'end_turn' };
    });

    const connectAcp = vi.fn(async () => {
      connectCount += 1;
      if (connectCount === 2) {
        throw new Error('attach failed for fail-1');
      }
      return bridge;
    });

    let workerHarnessEvents = 0;
    let statusChecked = false;

    mockSend.mockImplementation(async (message: string) => {
      if (
        isWorkerCompletedConductorMessage(message) ||
        message.includes('## worker 失敗')
      ) {
        workerHarnessEvents += 1;
      }

      if (workerHarnessEvents >= 2 && !statusChecked) {
        statusChecked = true;

        const listed = await conductorTools.list_workers!.execute({});
        const summary = parseYamlBlock(String(listed.content[0]?.text ?? ''));
        expect(summary).toMatchObject({
          runningCount: 0,
          attachedCount: 1,
          workerFailureCount: 1,
        });

        const workers = summary.workers as Array<Record<string, unknown>>;
        expect(workers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'ping-1', state: 'idle' }),
            expect.objectContaining({
              name: 'fail-1',
              state: 'failed',
              error: 'attach failed for fail-1',
            }),
          ]),
        );

        const detail = await conductorTools.get_worker_status!.execute({
          worker: 'ping-1',
        });
        const status = parseYamlBlock(String(detail.content[0]?.text ?? ''));
        expect(status).toMatchObject({
          name: 'ping-1',
          state: 'idle',
          queueDepth: 0,
        });

        return {
          runId: 'run-status',
          status: 'finished',
          result: `attached=${summary.attachedCount}, failures=${summary.workerFailureCount}`,
        };
      }

      return {
        runId: `run-${workerHarnessEvents}`,
        status: 'finished',
        result: 'progress',
      };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: TWO_WORKER_PROFILE,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp,
      ownsWorkerAcpConnections: false,
    });

    expect(statusChecked).toBe(true);
    expect(result.workerFailures).toHaveLength(1);
    expect(result.workerFailures[0]?.name).toBe('fail-1');
    expect(result.lastResult).toContain('attached=1');
    expect(result.lastResult).toContain('failures=1');
  });
});
