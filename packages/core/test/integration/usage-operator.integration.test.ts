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
import {
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ONE_WORKER_PROFILE: Profile = {
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

function parseYamlBlock(text: string): Record<string, unknown> {
  const match = text.match(/```yaml\n# [^\n]+\n([\s\S]*?)```/);
  if (!match?.[1]) {
    throw new Error(`YAML block not found in: ${text.slice(0, 200)}`);
  }
  return yaml.load(match[1]) as Record<string, unknown>;
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

        const summaryResult = await conductorTools.get_session_usage!.execute({});
        const summary = parseYamlBlock(String(summaryResult.content[0]?.text ?? ''));
        const totals = summary.totals as Record<string, unknown>;
        const tokens = totals.tokens as Record<string, number>;
        const context = summary.context as Record<string, unknown>;

        expect(tokens.inputTokens).toBeGreaterThanOrEqual(200);
        expect(tokens.outputTokens).toBeGreaterThanOrEqual(80);
        expect(context).toMatchObject({
          limit: 100_000,
          percent: 1,
        });

        const detail = await conductorTools.get_usage!.execute({ agent: 'ping-1' });
        const round = parseYamlBlock(String(detail.content[0]?.text ?? ''));
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
    expect(result.sessionUsage?.totals.rounds).toBeGreaterThanOrEqual(2);
    expect(result.sessionUsage?.context.limit).toBe(100_000);
  });
});
