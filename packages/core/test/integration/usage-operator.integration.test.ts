import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import yaml from 'js-yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpBridge } from '../../src/acp/acp-bridge.js';
import { AcpClient } from '../../src/acp/acp-client.js';
import { startFakeAcpServer } from '../../src/acp/testing/fake-acp-server.js';
import { createInProcessStreamPair } from '../../src/acp/testing/stream-pair.js';
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

const ONE_WORKER_PROFILE: Profile = {
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  workers: [{ name: 'ping-1', kind: 'ping' }],
};

const { mockSend, mockClose, mockCreate, mockCreateCursorSdkConductorAgentFactory } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockCreateCursorSdkConductorAgentFactory = vi.fn();
  return { mockSend, mockClose, mockCreate, mockCreateCursorSdkConductorAgentFactory };
});

let conductorTools: Record<string, SDKCustomTool> = {};

vi.mock('../../src/conductor/cursor-sdk-conductor-agent.js', () => ({
  createCursorSdkConductorAgentFactory: mockCreateCursorSdkConductorAgentFactory,
}));

function parseYamlBlock(text: string): Record<string, unknown> {
  const match = text.match(/```yaml\n# [^\n]+\n([\s\S]*?)```/);
  if (!match?.[1]) {
    throw new Error(`YAML block not found in: ${text.slice(0, 200)}`);
  }
  return yaml.load(match[1]) as Record<string, unknown>;
}

function toolContentText(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result == null ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error('Tool result has no content block');
  }
  const first = result.content[0];
  if (
    typeof first !== 'object' ||
    first == null ||
    !('text' in first) ||
    typeof first.text !== 'string'
  ) {
    throw new Error('Tool result has no text content');
  }
  return first.text;
}

describe('usage operator integration', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Usage test',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);

    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockCreate,
    });
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

  it('get_session_usage answers operator token / context % questions', async () => {
    const bridge = await createInProcessAcpBridge(async ({ notify, sessionId }) => {
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pong' },
        },
      });
      return {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 200,
          outputTokens: 80,
          totalTokens: 280,
        },
      };
    });

    let workerHarnessEvents = 0;
    let usageChecked = false;

    mockSend.mockImplementation(async (message: string) => {
      if (isWorkerCompletedConductorMessage(message)) {
        workerHarnessEvents += 1;
      }

      if (workerHarnessEvents >= 1 && !usageChecked) {
        usageChecked = true;

        const summaryResult = await conductorTools.get_session_usage!.execute(
          {},
          {},
        );
        const summary = parseYamlBlock(toolContentText(summaryResult));
        const totals = summary.totals as Record<string, unknown>;
        const tokens = totals.tokens as Record<string, number>;
        const context = summary.context as Record<string, unknown>;

        expect(summary.tokenScope).toBe('recorded-usage-only');
        expect(tokens.inputTokens).toBeGreaterThanOrEqual(200);
        expect(tokens.outputTokens).toBeGreaterThanOrEqual(80);
        expect(context).toMatchObject({
          limit: 100_000,
          percent: 1,
        });

        const detail = await conductorTools.get_usage!.execute(
          { agent: 'ping-1' },
          {},
        );
        const round = parseYamlBlock(toolContentText(detail));
        expect(round).toMatchObject({
          agentName: 'ping-1',
          usage: { source: 'acp', inputTokens: 200, outputTokens: 80 },
        });

        return {
          runId: 'run-usage',
          status: 'finished',
          result: `input=${tokens.inputTokens}, percent=${context.percent}%`,
          usage: {
            inputTokens: 1200,
            outputTokens: 300,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 1500,
          },
        };
      }

      return {
        runId: `run-${workerHarnessEvents}`,
        status: 'finished',
        result: 'progress',
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 600,
        },
      };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: ONE_WORKER_PROFILE,
      maxTurns: 10,
      contextLimitTokens: 100_000,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(usageChecked).toBe(true);
    expect(result.lastResult).toContain('input=');
    expect(result.lastResult).toContain('percent=');
    expect(result.sessionUsage?.tokenScope).toBe('recorded-usage-only');
    expect(result.sessionUsage?.totals.rounds).toBeGreaterThanOrEqual(2);
    expect(result.sessionUsage?.context.limit).toBe(100_000);
    expect(result.sessionUsage?.byAgent.workers['ping-1']?.tokens).toMatchObject({
      inputTokens: 200,
      outputTokens: 80,
    });
    expect(result.sessionUsage?.cacheStats?.totals).toMatchObject({
      cacheReadTokens: 0,
      cacheHitRate: 0,
    });
  });

  it('get_session_usage marks recorded token scope after a worker failure without usage', async () => {
    const streams = createInProcessStreamPair();
    const fakeServer = startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
    });
    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    await client.connect();

    let failedWorkerUsage: Record<string, unknown> | undefined;
    mockSend.mockImplementation(async (message: string) => {
      if (message.includes('permission 判断待ち')) {
        streams.clientReadable.destroy(new Error('ACP disconnected after dispatch'));
        return {
          runId: 'run-permission-failure',
          status: 'finished',
          result: 'permission interrupted',
          usage: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
          },
        };
      }

      if (message.includes('## worker 失敗')) {
        const summaryResult = await conductorTools.get_session_usage!.execute(
          {},
          {},
        );
        failedWorkerUsage = parseYamlBlock(toolContentText(summaryResult));
        return {
          runId: 'run-worker-failure',
          status: 'finished',
          result: 'worker failure handled',
          usage: {
            inputTokens: 50,
            outputTokens: 10,
            totalTokens: 60,
          },
        };
      }

      return {
        runId: 'run-initial',
        status: 'finished',
        result: 'initial',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      };
    });

    try {
      const result = await runConductorSession({
        issueUrl: TEST_ISSUE.url,
        repoRoot: REPO_ROOT,
        profile: ONE_WORKER_PROFILE,
        maxTurns: 10,
        permissionPipeline: new PermissionPipeline({
          policy: { allowTools: [], allowReadOnlyTools: false },
        }),
        connectAcp: async () => AcpBridge.fromClient(client),
        ownsWorkerAcpConnections: true,
        disableGitHubMonitor: true,
        disablePermissionDeadlockMonitor: true,
      });

      expect(result.workerFailures).toHaveLength(1);
      expect(failedWorkerUsage).toMatchObject({
        tokenScope: 'recorded-usage-only',
        byAgent: { workers: {} },
      });
      expect(result.sessionUsage?.byAgent.workers).toEqual({});
      expect(result.sessionUsage?.tokenScope).toBe('recorded-usage-only');
    } finally {
      fakeServer.stop();
      streams.clientReadable.destroy();
      streams.clientWritable.destroy();
    }
  });
});
