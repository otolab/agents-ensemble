import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import type { Profile } from '../../src/profile/types.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ROUNDTRIP_PROFILE: Profile = {
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

function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text?: string }).text ?? '')
          : '',
      )
      .join('\n');
  }
  return JSON.stringify(prompt);
}

describe('prompt_worker roundtrip integration', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Roundtrip test',
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

  it('delivers two prompt_worker rounds via worker.completed events', async () => {
    const bridge = await createInProcessAcpBridge(async ({ prompt, notify, sessionId }) => {
      const text = promptText(prompt);
      const responseText = text.includes('round-2') ? 'round2' : 'pong';
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: responseText },
        },
      });
      return { stopReason: 'end_turn' };
    });

    let workerCompletedEvents = 0;
    mockSend.mockImplementation(async (message: string) => {
      if (!isWorkerCompletedConductorMessage(message)) {
        return { runId: 'run-init', status: 'finished', result: 'init' };
      }

      workerCompletedEvents += 1;
      if (workerCompletedEvents === 1) {
        await conductorTools.prompt_worker!.execute({
          worker: 'ping-1',
          instruction: 'round-1: respond with pong',
        });
        return { runId: 'run-1', status: 'finished', result: 'dispatched round-1' };
      }
      if (workerCompletedEvents === 2) {
        await conductorTools.prompt_worker!.execute({
          worker: 'ping-1',
          instruction: 'round-2: respond with round2',
        });
        return { runId: 'run-2', status: 'finished', result: 'dispatched round-2' };
      }
      return { runId: 'run-done', status: 'finished', result: 'conductor-ok' };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: ROUNDTRIP_PROFILE,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(result.stopReason).toBe('completed');
    expect(result.lastResult).toContain('conductor-ok');
    expect(result.workerFailures).toHaveLength(0);
    expect(result.workerDispatches).toHaveLength(3);

    const prompts = result.workerDispatches.map((dispatch) => dispatch.prompt);
    expect(prompts[1]).toContain('round-1');
    expect(prompts[2]).toContain('round-2');

    expect(
      result.workerDispatches.map(
        (dispatch) => dispatch.promptResult.responseText,
      ),
    ).toEqual(['pong', 'pong', 'round2']);

    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    const workerCompletedMessages = messages.filter(isWorkerCompletedConductorMessage);
    expect(workerCompletedMessages).toHaveLength(3);
    expect(
      workerCompletedMessages.filter((message) =>
        message.includes('## worker bootstrap 完了'),
      ),
    ).toHaveLength(1);
    expect(
      workerCompletedMessages.filter((message) =>
        message.includes('## worker 作業ラウンド完了'),
      ),
    ).toHaveLength(2);
  });
});
