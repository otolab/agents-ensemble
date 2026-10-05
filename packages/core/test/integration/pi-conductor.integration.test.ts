import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  // The in-process bridge never spawns an ACP CLI, but the session validates
  // the resolved worker preset before it attaches the injected bridge.
  acp: { preset: 'custom', command: process.execPath },
  workers: [{ name: 'ping-1', kind: 'ping' }],
};

const PI_NO_WORKER_PROFILE: Profile = {
  agents: {},
  workers: [],
};

interface FakePiSessionOptions {
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
  sessionManager?: {
    appendMessage: (message: unknown) => string;
  };
}

const { fakeSessions, createFakeAgentSession } = vi.hoisted(() => {
  const sessions: FakePiSession[] = [];

  class FakePiSession {
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

    constructor(options: FakePiSessionOptions) {
      this.state = {
        systemPrompt: options.initialState.systemPrompt,
        model: options.initialState.model,
        tools: options.initialState.tools ?? [],
        messages: [...(options.initialState.messages ?? [])],
      };
      this.sessionId = options.sessionId;
      this.sessionManager = options.sessionManager;
      this.initialMessageCount = this.state.messages.length;
      sessions.push(this);
    }

    subscribe(listener: (event: any) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    async prompt(prompt: string): Promise<void> {
      this.prompts.push(prompt);
      if (this.turn === 0 && this.state.messages.length > 0) {
        this.turn += 1;
        this.appendUserMessage(prompt);
        this.finish('conductor-resumed');
        return;
      }

      if (this.turn === 0) {
        this.turn += 1;
        const tool = this.state.tools.find((candidate) => candidate.name === 'prompt_worker');
        if (!tool || !this.state.systemPrompt.includes('ping-1')) {
          this.appendUserMessage(prompt);
          this.finish('conductor-first');
          return;
        }

        this.appendUserMessage(prompt);
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

      this.appendUserMessage(prompt);
      this.finish('conductor-ok');
    }

    abort(): void {}

    dispose(): void {}

    async bindExtensions(): Promise<void> {}

    async reload(): Promise<void> {}

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
      this.sessionManager?.appendMessage(message);
      this.emit({ type: 'agent_end', messages: [message] });
    }

    private appendUserMessage(prompt: string): void {
      const message = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: prompt }],
        timestamp: Date.now(),
      };
      this.state.messages.push(message);
      this.sessionManager?.appendMessage(message);
    }

    private emit(event: any): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    private readonly sessionManager?: {
      appendMessage: (message: unknown) => string;
    };
  }

  function createFakeAgentSession(options: any): { session: FakePiSession; extensionsResult: { errors: [] } } {
    const sessionManager = options.sessionManager;
    const initialMessages = sessionManager?.buildSessionContext?.().messages ?? [];
    const session = new FakePiSession({
      initialState: {
        systemPrompt: options.resourceLoader?.getSystemPrompt?.() ?? '',
        model: options.model ?? {},
        messages: initialMessages,
        tools: options.customTools ?? [],
      },
      sessionId: sessionManager?.getSessionId?.(),
      sessionManager,
    });
    return { session, extensionsResult: { errors: [] } };
  }

  return { fakeSessions: sessions, createFakeAgentSession };
});

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );
  return {
    ...actual,
    createAgentSession: vi.fn((options: unknown) =>
      Promise.resolve(createFakeAgentSession(options)),
    ),
  };
});

describe('Pi conductor backend integration', () => {
  beforeEach(() => {
    fakeSessions.length = 0;
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
    const piAgentDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-agent-'));
    const piProjectDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-project-'));
    await mkdir(join(piProjectDir, 'extensions'), { recursive: true });
    await writeFile(
      join(piProjectDir, 'extensions', 'integration-extension.mjs'),
      `export default (pi) => pi.registerTool({
        name: 'integration_extension',
        description: 'Loaded from the project Pi resource root',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'loaded' }] }),
      });`,
    );
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      conductorCwd: REPO_ROOT,
      profile: PI_PROFILE,
      ensembleConfig: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: {
          ...DEFAULT_ENSEMBLE_CONFIG.conductor,
          backend: 'pi',
          pi: { agentDir: piAgentDir, projectDir: piProjectDir },
        },
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

    const [session] = fakeSessions;
    expect(session).toBeDefined();
    expect(session?.state.systemPrompt).toContain('PI_COMPILED_SYSTEM_MARKER');
    const toolNames = session?.state.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('prompt_worker');
    expect(toolNames).toContain('integration_extension');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('edit');
    expect(toolNames).not.toContain('read');
    expect(session?.prompts[0]).toContain(TEST_ISSUE.url);
    expect(session?.prompts[0]).not.toContain('PI_COMPILED_SYSTEM_MARKER');
    expect(session?.prompts.length).toBeGreaterThanOrEqual(2);
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
    expect(fakeSessions).toHaveLength(2);
    expect(fakeSessions[0]?.sessionId).toBe(first.agentId);
    expect(fakeSessions[1]?.sessionId).toBe(first.agentId);
    expect(fakeSessions[0]?.initialMessageCount).toBe(0);
    expect(fakeSessions[1]?.initialMessageCount).toBe(2);
    expect(fakeSessions[1]?.state.messages.length).toBeGreaterThan(1);
    expect(fakeSessions[1]?.state.systemPrompt).toContain(
      'PI_COMPILED_SYSTEM_MARKER',
    );
    expect(fakeSessions[1]?.prompts[0]).toContain('continue');
    expect(fakeSessions[1]?.prompts[0]).not.toContain(
      'Start the conductor workflow',
    );
  });
});
