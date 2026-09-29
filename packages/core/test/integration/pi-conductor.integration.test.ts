import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../src/config/defaults.js';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import { createTestOperatorInputBinding } from '../../src/conductor/testing/test-operator-input-binding.js';
import type { Profile } from '../../src/profile/types.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const PI_PROFILE: Profile = {
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  workers: [{ name: 'ping-1', kind: 'ping' }],
};

const PI_NO_WORKER_PROFILE: Profile = {
  agents: {},
  workers: [],
};

interface FakePiAgentOptions {
  initialState: {
    systemPrompt: string;
    model: { id?: string };
    messages?: unknown[];
    tools?: Array<{
      name: string;
      execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>;
    }>;
  };
  sessionId?: string;
}

const { fakeAgents, FakePiAgent } = vi.hoisted(() => {
  const agents: FakePiAgent[] = [];

  class FakePiAgent {
    readonly state: {
      systemPrompt: string;
      model: { id?: string };
      tools: Array<{
        name: string;
        execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>;
      }>;
      messages: unknown[];
    };
    readonly sessionId?: string;
    readonly initialMessageCount: number;
    readonly prompts: string[] = [];
    private readonly listeners = new Set<(event: any) => void>();
    private turn = 0;

    constructor(options: FakePiAgentOptions) {
      this.state = {
        systemPrompt: options.initialState.systemPrompt,
        model: options.initialState.model,
        tools: options.initialState.tools ?? [],
        messages: [...(options.initialState.messages ?? [])],
      };
      this.sessionId = options.sessionId;
      this.initialMessageCount = this.state.messages.length;
      agents.push(this);
    }

    subscribe(listener: (event: any) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    async prompt(prompt: string): Promise<void> {
      this.prompts.push(prompt);
      if (this.turn === 0 && this.state.messages.length > 0) {
        this.turn += 1;
        this.finish('conductor-resumed');
        return;
      }

      if (this.turn === 0) {
        this.turn += 1;
        const tool = this.state.tools.find((candidate) => candidate.name === 'prompt_worker');
        if (!tool || !this.state.systemPrompt.includes('ping-1')) {
          this.finish('conductor-first');
          return;
        }

        this.emit({
          type: 'tool_execution_start',
          toolCallId: 'pi-call-1',
          toolName: tool.name,
          args: {
            worker: 'ping-1',
            instruction: 'round-1: respond with pong',
          },
        });
        await tool.execute('pi-call-1', {
          worker: 'ping-1',
          instruction: 'round-1: respond with pong',
        });
        this.emit({
          type: 'tool_execution_end',
          toolCallId: 'pi-call-1',
          toolName: tool.name,
          result: { content: [{ type: 'text', text: 'dispatched' }] },
          isError: false,
        });
        this.finish('dispatched');
        return;
      }

      this.finish('conductor-ok');
    }

    abort(): void {}

    async waitForIdle(): Promise<void> {}

    private finish(text: string): void {
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
        api: 'anthropic-messages' as const,
        provider: 'anthropic',
        model: this.state.model.id ?? 'fake-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      };
      this.state.messages.push(message);
      this.emit({ type: 'agent_end', messages: [message] });
    }

    private emit(event: any): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  return { fakeAgents: agents, FakePiAgent };
});

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: FakePiAgent }));

describe('Pi conductor backend integration', () => {
  beforeEach(() => {
    fakeAgents.length = 0;
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Pi backend integration',
      body: 'PI_COMPILED_SYSTEM_MARKER',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs Pi kickoff through the real harness registry and a fake ACP worker', async () => {
    const bridge = await createInProcessAcpBridge();
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      conductorCwd: REPO_ROOT,
      profile: PI_PROFILE,
      ensembleConfig: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: { ...DEFAULT_ENSEMBLE_CONFIG.conductor, backend: 'pi' },
      },
      modelId: 'anthropic/claude-sonnet-4-5',
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      disableGitHubMonitor: true,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(result.stopReason).toBe('completed');
    expect(result.lastResult).toContain('conductor-ok');
    expect(result.workerFailures).toHaveLength(0);
    const workerDispatch = result.workerDispatches.find((dispatch) =>
      dispatch.prompt.includes('round-1'),
    );
    expect(workerDispatch?.name).toBe('ping-1');
    expect(workerDispatch?.promptResult.responseText).toContain('pong');

    const [agent] = fakeAgents;
    expect(agent).toBeDefined();
    expect(agent?.state.systemPrompt).toContain('PI_COMPILED_SYSTEM_MARKER');
    const toolNames = agent?.state.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('prompt_worker');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('edit');
    expect(toolNames).not.toContain('read');
    expect(agent?.prompts[0]).toContain(TEST_ISSUE.url);
    expect(agent?.prompts[0]).not.toContain('PI_COMPILED_SYSTEM_MARKER');
    expect(agent?.prompts.length).toBeGreaterThanOrEqual(2);
  });

  it('resumes a stopped Pi session with the same backend and transcript', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-pi-resume-'));
    const ensembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      conductor: { ...DEFAULT_ENSEMBLE_CONFIG.conductor, backend: 'pi' as const },
    };

    const first = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      conductorCwd: repoRoot,
      profile: PI_NO_WORKER_PROFILE,
      ensembleConfig,
      modelId: 'anthropic/claude-sonnet-4-5',
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      disableGitHubMonitor: true,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    const operator = createTestOperatorInputBinding(() => 'continue');
    const resumed = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      conductorCwd: repoRoot,
      profile: PI_NO_WORKER_PROFILE,
      ensembleConfig,
      modelId: 'anthropic/claude-sonnet-4-5',
      resumeAgentId: first.agentId,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      disableGitHubMonitor: true,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(first.lastResult).toBe('conductor-first');
    expect(resumed.lastResult).toBe('conductor-resumed');
    expect(fakeAgents).toHaveLength(2);
    expect(fakeAgents[0]?.sessionId).toBe(first.agentId);
    expect(fakeAgents[1]?.sessionId).toBe(first.agentId);
    expect(fakeAgents[0]?.initialMessageCount).toBe(0);
    expect(fakeAgents[1]?.initialMessageCount).toBe(1);
    expect(fakeAgents[1]?.state.messages.length).toBeGreaterThan(1);
    expect(fakeAgents[1]?.state.systemPrompt).toContain(
      'PI_COMPILED_SYSTEM_MARKER',
    );
    expect(fakeAgents[1]?.prompts[0]).toContain('continue');
    expect(fakeAgents[1]?.prompts[0]).not.toContain(
      'Start the conductor workflow',
    );
  });
});
