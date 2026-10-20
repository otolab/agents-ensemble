import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import type { AcpBridge } from '../acp/acp-bridge.js';
import type { PermissionDecision, PermissionHandler } from '../acp/types.js';
import * as issueContextModule from '../github/issue-context.js';
import * as resolveGitHubAuthTokenModule from '../github/resolve-github-auth-token.js';
import { GitHubMonitorError } from '../github/github-monitor-error.js';
import type {
  GitHubClient,
  GitHubPullRequestRef,
} from '../github/github-client.js';
import type { GitHubMonitorCursor } from '../github/github-monitor-cursor.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { computeMcpConfigDigest } from '../mcp/load-mcp-config.js';
import {
  loadSessionSidecar,
  saveSessionSidecar,
  SessionSidecarNotFoundError,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
} from '../session/session-sidecar.js';
import { openQuestionsStorePath } from '../session/open-questions-store.js';
import { SessionLogger, type SessionLogEvent } from './session/session-logger.js';
import { runConductorSession as runConductorSessionImpl } from './conductor-session.js';
import type { OperatorInputBindingApi } from './operator-input-binding.js';
import * as worktreeModule from '../worktree/worktree.js';
import type {
  GitHubUpdateKind,
  GitHubUpdatePayload,
} from '../github/github-update-types.js';
import { createMockConductorGetUsage } from '../testing/mock-conductor-get-usage.js';
import type { ConductorAgentCreateOptions } from './conductor-agent.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

const {
  mockSend,
  mockClose,
  mockCreate,
  mockResume,
  mockCreateCursorSdkConductorAgentFactory,
  mockCreatePiConductorAgentFactory,
} = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockResume = vi.fn();
  const mockCreateCursorSdkConductorAgentFactory = vi.fn();
  const mockCreatePiConductorAgentFactory = vi.fn();
  return {
    mockSend,
    mockClose,
    mockCreate,
    mockResume,
    mockCreateCursorSdkConductorAgentFactory,
    mockCreatePiConductorAgentFactory,
  };
});

vi.mock('./cursor-sdk-conductor-agent.js', () => ({
  createCursorSdkConductorAgentFactory: mockCreateCursorSdkConductorAgentFactory,
}));

vi.mock('./pi-conductor-agent.js', () => ({
  createPiConductorAgentFactory: mockCreatePiConductorAgentFactory,
}));

const { mockCreateGitHubMonitor } = vi.hoisted(() => {
  const mockCreateGitHubMonitor = vi.fn();
  return { mockCreateGitHubMonitor };
});

vi.mock('../github/github-monitor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../github/github-monitor.js')>();
  return {
    ...original,
    createGitHubMonitor: mockCreateGitHubMonitor,
  };
});

function issueCommentUpdate(body: string): GitHubUpdatePayload {
  return {
    items: [
      {
        id: 'issue-comment:99',
        kind: 'issue.comment',
        summary: body,
        bodyPreview: body,
      },
    ],
  };
}

function githubUpdate(kind: GitHubUpdateKind): GitHubUpdatePayload {
  return {
    items: [
      {
        id: `${kind}:99`,
        kind,
        summary: `${kind} update`,
      },
    ],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function drainAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runConductorSession resume / shutdown', () => {
  let repoRoot = '';
  let userEnsembleRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-conductor-'));
    userEnsembleRoot = await mkdtemp(join(tmpdir(), 'ensemble-conductor-user-'));

    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Test',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(resolveGitHubAuthTokenModule, 'resolveGitHubAuthToken').mockResolvedValue({
      token: 'test-github-token',
      source: 'GITHUB_TOKEN',
    });
    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreatePiConductorAgentFactory.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockResume,
    });
    mockCreatePiConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockResume,
    });
    mockCreate.mockImplementation(async () => ({
      agentId: 'agent-test',
      send: mockSend,
      close: mockClose,
      getUsage: createMockConductorGetUsage(),
    }));
    mockResume.mockImplementation(async () => ({
      agentId: 'agent-test',
      send: mockSend,
      close: mockClose,
      getUsage: createMockConductorGetUsage(),
    }));
    mockCreateGitHubMonitor.mockReset();
    mockCreateGitHubMonitor.mockImplementation((options) => ({
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn(),
      getCursor: vi.fn().mockReturnValue({ lastIssueCommentId: undefined, pullRequests: {} }),
      acknowledgeUpdates: vi.fn(),
      unregisterPullRequest: vi.fn(),
      onUpdate: options.onUpdate,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runConductorSession(
    options: Parameters<typeof runConductorSessionImpl>[0],
  ) {
    return runConductorSessionImpl({
      ...options,
      mcpConfigOptions: {
        ...options.mcpConfigOptions,
        userEnsembleRoot,
      },
    });
  }

  it('fails fast when resumeAgentId is set but sidecar is missing', async () => {
    await expect(
      runConductorSession({
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        resumeAgentId: 'missing-agent',
        permissionPipeline: new PermissionPipeline({}),
        registerProcessSignalHandlers: false,
      }),
    ).rejects.toThrow(SessionSidecarNotFoundError);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('fails fast when the startup backend differs from the sidecar backend', async () => {
    const agentId = 'resume-backend-mismatch';
    await saveSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: agentId }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: agentId,
        conductorBackend: 'pi',
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: 0,
      },
    );

    await expect(
      runConductorSession({
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        resumeAgentId: agentId,
        permissionPipeline: new PermissionPipeline({}),
        registerProcessSignalHandlers: false,
      }),
    ).rejects.toThrow(/conductorBackend mismatch/);

    expect(mockResume).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('selects the Pi factory and sends a short kickoff instead of the compiled prompt', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-pi-kickoff',
      status: 'finished',
      result: 'started',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      ensembleConfig: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: { ...DEFAULT_ENSEMBLE_CONFIG.conductor, backend: 'pi' },
      },
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockCreatePiConductorAgentFactory).toHaveBeenCalledOnce();
    expect(mockCreateCursorSdkConductorAgentFactory).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('body'),
        builtinTools: true,
      }),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining(TEST_ISSUE.url),
      expect.any(Object),
    );
    expect(mockSend.mock.calls[0]?.[0]).not.toContain('body');
  });

  it('shares Pi tokens and successful compactions with get_session_usage while omitting estimated cost', async () => {
    let createOptions: ConductorAgentCreateOptions | undefined;
    mockCreate.mockImplementationOnce(async (options: ConductorAgentCreateOptions) => {
      createOptions = options;
      options.onContextCompaction?.();
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: vi.fn().mockResolvedValue({}),
      };
    });
    mockSend.mockResolvedValue({
      runId: 'run-pi-usage',
      status: 'finished',
      result: 'done',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { conductor: { backend: 'pi' }, workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(result.sessionUsage).toMatchObject({
      totals: {
        rounds: 1,
        tokens: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      },
      compactionCount: 1,
    });
    expect(result.sessionUsage).not.toHaveProperty('cost');

    const usageTool = createOptions?.customTools?.get_session_usage;
    expect(usageTool).toBeDefined();
    const usageResult = await usageTool!.execute({});
    expect(usageResult.structuredContent).toMatchObject({
      totals: {
        rounds: 1,
        tokens: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      },
      compactionCount: 1,
    });
    expect(usageResult.structuredContent).not.toHaveProperty('cost');
  });

  it('adds the user-wide document to the conductor prompt from the shared user root', async () => {
    await writeFile(
      join(userEnsembleRoot, 'AGENTS.md'),
      'Shared operator context for every repository.',
    );
    mockSend.mockResolvedValue({
      runId: 'run-user-instructions',
      status: 'finished',
      result: 'started',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Shared operator context for every repository.',
        ),
      }),
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('## Prepared Materials'),
      }),
    );
  });

  it(
    'fails before fetching the Issue or starting the agent when the user document is unreadable',
    async () => {
      await mkdir(join(userEnsembleRoot, 'AGENTS.md'));

      await expect(
        runConductorSession({
          issueUrl: TEST_ISSUE.url,
          repoRoot,
          profile: { workers: [] },
          permissionPipeline: new PermissionPipeline({}),
          registerProcessSignalHandlers: false,
        }),
      ).rejects.toThrow(/Failed to read user instructions at .*AGENTS\.md/);

      expect(issueContextModule.fetchIssueContext).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  it('passes profile conductor builtinTools to the backend factory', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-pi-tools-disabled',
      status: 'finished',
      result: 'started',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { conductor: { backend: 'pi', builtinTools: false }, workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ builtinTools: false }),
    );
  });

  it('passes resolved Pi resource root overrides to create options', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-pi-resources',
      status: 'finished',
      result: 'started',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      ensembleConfig: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: {
          ...DEFAULT_ENSEMBLE_CONFIG.conductor,
          backend: 'pi',
          pi: {
            agentDir: '~/.custom-pi',
            projectDir: '.custom-project-pi',
          },
        },
      },
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        pi: {
          agentDir: join(homedir(), '.custom-pi'),
          projectDir: join(repoRoot, '.custom-project-pi'),
        },
      }),
    );
  });

  it('does not fail at backend selection before the Pi agent is created', async () => {
    const resolveWorkerWorkspace = vi
      .spyOn(worktreeModule, 'resolveWorkerWorkspace')
      .mockResolvedValue({
        path: join(repoRoot, 'worker'),
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
        inRepo: false,
      });
    mockSend.mockResolvedValue({
      runId: 'run-pi-selection',
      status: 'finished',
      result: 'done',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { conductor: { backend: 'pi' }, workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(resolveWorkerWorkspace).not.toHaveBeenCalled();
    expect(mockCreatePiConductorAgentFactory).toHaveBeenCalledOnce();
  });

  it('persists the selected profile backend in the sidecar', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-pi-stub',
      status: 'finished',
      result: 'done',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { conductor: { backend: 'pi' }, workers: [] },
      conductorAgentFactory: { create: mockCreate, resume: mockResume },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    const sidecar = await loadSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
    );
    expect(sidecar?.conductorBackend).toBe('pi');
  });

  it('passes resolved MCP configuration to ConductorAgent.resume for explicit resume', async () => {
    const agentId = 'resume-agent';
    const projectMcpRoot = join(repoRoot, '.agents');
    await mkdir(projectMcpRoot, { recursive: true });
    await writeFile(
      join(projectMcpRoot, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        },
      }),
    );
    await saveSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: agentId }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: agentId,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        mcpConfigDigest: computeMcpConfigDigest({
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        }),
        updatedAt: 0,
      },
    );
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: agentId,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockResume).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        systemPrompt: expect.stringContaining('body'),
        mcpServers: {
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        },
      }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('exposes restored open questions through the operator context on resume', async () => {
    const agentId = 'resume-agent-with-questions';
    const restoredQuestions = [
      {
        id: 'inq-1',
        question: 'Resume first?',
        responseType: 'text' as const,
        source: 'conductor' as const,
        status: 'open' as const,
        askedAt: 1,
      },
      {
        id: 'inq-2',
        question: 'Resume second?',
        responseType: 'yes_no' as const,
        source: 'conductor' as const,
        status: 'open' as const,
        askedAt: 2,
      },
    ];
    await saveSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: agentId }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: agentId,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        openQuestions: restoredQuestions,
        sequence: restoredQuestions.length,
        workers: {},
        updatedAt: 0,
      },
    );
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    let operatorContext: ReturnType<OperatorInputBindingApi['getContext']> | undefined;
    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: agentId,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
      bindOperatorInput: (api) => {
        operatorContext = api.getContext();
        for (const question of restoredQuestions) {
          api.submit('answer', { targetOpenQuestionId: question.id });
        }
        return () => {};
      },
    });

    expect(operatorContext?.openQuestions).toEqual(restoredQuestions);
  });

  it('passes project MCP configuration to the conductor options', async () => {
    const projectMcpRoot = join(repoRoot, '.agents');
    await mkdir(projectMcpRoot, { recursive: true });
    await writeFile(
      join(projectMcpRoot, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        },
      }),
    );
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('body'),
        mcpServers: expect.objectContaining({
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        }),
      }),
    );
    const sidecar = await loadSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
    );
    expect(sidecar?.conductorBackend).toBe('cursor');
  });

  it('registers the GitHub watch tool and persists a tool registration', async () => {
    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    mockCreate.mockImplementationOnce(async (agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
    mockSend.mockImplementationOnce(async () => {
      await conductorTools!.register_github_watch!.execute({ prNumber: 354 });
      return {
        runId: 'run-1',
        status: 'finished',
        result: 'registered',
      };
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(conductorTools?.register_github_watch).toBeDefined();
    expect(conductorTools?.unregister_github_watch).toBeDefined();
    const sidecar = await loadSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
    );
    expect(sidecar?.githubMonitor?.explicitPullRequests?.['354']).toMatchObject({
      registeredAt: expect.any(String),
      kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
    });
  });

  it('unregisters a resumed GitHub watch and preserves its poll cursor in the sidecar', async () => {
    const agentId = 'resume-agent-with-github-watch';
    await saveSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: agentId }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: agentId,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        githubMonitor: {
          pullRequests: { '354': { lastReviewId: '10' } },
          explicitPullRequests: {
            '354': {
              registeredAt: '2026-09-07T05:00:00.000Z',
              kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
            },
          },
        },
        updatedAt: 0,
      },
    );

    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    mockResume.mockImplementation(async (_agentId, agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId,
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });

    let unregisterPullRequest: ReturnType<typeof vi.fn> | undefined;
    mockCreateGitHubMonitor.mockImplementationOnce((monitorOptions) => {
      const cursor = monitorOptions.cursor!;
      unregisterPullRequest = vi.fn((prNumber: number) => {
        delete cursor.explicitPullRequests?.[String(prNumber)];
        monitorOptions.onCursorChange?.(cursor);
      });
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn(),
        getCursor: vi.fn(() => cursor),
        registerPullRequest: vi.fn(),
        unregisterPullRequest,
      };
    });
    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: agentId,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockResume).toHaveBeenCalled();
    expect(conductorTools?.unregister_github_watch).toBeDefined();
    await conductorTools!.unregister_github_watch!.execute({ prNumber: 354 });
    expect(unregisterPullRequest).toHaveBeenCalledWith(354);
    await vi.waitFor(async () => {
      const sidecar = await loadSessionSidecar(
        sessionSidecarPath({ repoRoot, conductorAgentId: agentId }),
      );
      expect(sidecar?.githubMonitor?.explicitPullRequests).toEqual({});
    });
    const sidecar = await loadSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: agentId }),
    );
    expect(sidecar?.githubMonitor?.explicitPullRequests).toEqual({});
    expect(sidecar?.githubMonitor?.pullRequests?.['354']).toEqual({
      lastReviewId: '10',
    });
  });

  it('registers set_dispatch_hold and records hold transitions without sidecar state', async () => {
    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    const events: SessionLogEvent[] = [];
    sessionLogger.subscribe((event) => events.push(event));
    mockCreate.mockImplementationOnce(async (agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
    mockSend.mockImplementationOnce(async () => {
      await conductorTools!.set_dispatch_hold!.execute({ hold: true });
      await conductorTools!.set_dispatch_hold!.execute({ hold: false });
      return {
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      };
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(conductorTools?.set_dispatch_hold).toBeDefined();
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'conductor.dispatch_hold',
          status: 'enabled',
          hold: true,
          heldEventCount: 0,
        },
        {
          type: 'conductor.dispatch_hold',
          status: 'released',
          hold: false,
          heldEventCount: 0,
          flushedEventCount: 0,
        },
      ]),
    );
  });

  it('records GitHub monitor recovery summaries in the session log', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-github-recovery',
      status: 'finished',
      result: 'done',
    });
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    const events: SessionLogEvent[] = [];
    sessionLogger.subscribe((event) => events.push(event));
    mockCreateGitHubMonitor.mockImplementationOnce((monitorOptions) => ({
      start: () => {
        monitorOptions.onPollError?.(
          new GitHubMonitorError({
            phase: 'issue_comments',
            cause: 'network',
            retryable: true,
            message: 'fetch failed',
          }),
        );
        monitorOptions.onPollRecovered?.(11, false);
      },
      stop: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn(),
      getCursor: vi.fn().mockReturnValue({ pullRequests: {} }),
      unregisterPullRequest: vi.fn(),
    }));

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(events).toContainEqual({
      type: 'harness.github.monitor_error',
      message: 'fetch failed',
      phase: 'issue_comments',
      prNumber: undefined,
      cause: 'network',
      retryable: true,
    });
    expect(events).toContainEqual({
      type: 'harness.github.monitor_recovered',
      suppressedErrorCount: 11,
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]?.[0]).toContain('## 接続復旧');
    expect(mockSend.mock.calls[1]?.[0]).toContain('suppressedErrorCount: 11');
  });

  it('coalesces GitHub monitor recovery with updates from the same poll', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-github-recovery-update',
      status: 'finished',
      result: 'done',
    });
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    const events: SessionLogEvent[] = [];
    sessionLogger.subscribe((event) => events.push(event));
    mockCreateGitHubMonitor.mockImplementationOnce((monitorOptions) => ({
      start: () => {
        monitorOptions.onPollRecovered?.(4, true);
        monitorOptions.onUpdate(issueCommentUpdate('recovered comment'));
      },
      stop: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn(),
      getCursor: vi.fn().mockReturnValue({ pullRequests: {} }),
      unregisterPullRequest: vi.fn(),
    }));

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    const recoveryDispatch = String(mockSend.mock.calls[1]?.[0]);
    expect(recoveryDispatch).toContain('## GitHub 更新・接続復旧（2 件）');
    expect(recoveryDispatch).toContain('suppressedErrorCount: 4');
    expect(recoveryDispatch).toContain('recovered comment');
    expect(events).toContainEqual({
      type: 'conductor.inbound',
      triggers: 1,
      sources: ['github'],
    });
  });

  it('delivers a runtime-registered PR update through the live monitor', async () => {
    vi.useFakeTimers();
    const shutdown = new AbortController();
    const firstSearch = createDeferred<GitHubPullRequestRef[]>();
    const firstSearchStarted = createDeferred<void>();
    const registrationCompleted = createDeferred<void>();
    const firstPollCompleted = createDeferred<void>();
    const bootstrapPollCompleted = createDeferred<void>();
    const githubUpdateMessage = createDeferred<string>();
    let searchPolls = 0;
    let cursorChanges = 0;
    let firstSearchResolved = false;
    let registeredDuringFirstPoll = false;
    const monitorUpdates: GitHubUpdatePayload[] = [];
    let liveMonitor: ReturnType<
      typeof import('../github/github-monitor.js').createGitHubMonitor
    > | undefined;

    const baselineReview = {
      id: 1,
      body: 'baseline review',
      html_url: 'https://github.com/org/repo/pull/354#review-1',
      user: { login: 'reviewer' },
      state: 'APPROVED',
      submitted_at: '2026-09-07T05:00:00Z',
    };
    const newReview = {
      ...baselineReview,
      id: 2,
      body: 'new review',
      html_url: 'https://github.com/org/repo/pull/354#review-2',
      submitted_at: '2026-09-07T05:01:00Z',
    };
    const baselineReviewComment = {
      id: 1,
      body: 'baseline comment',
      html_url: 'https://github.com/org/repo/pull/354#discussion_r1',
      user: { login: 'reviewer' },
      path: 'src/example.ts',
      created_at: '2026-09-07T05:00:00Z',
    };
    const newReviewComment = {
      ...baselineReviewComment,
      id: 2,
      body: 'new comment',
      html_url: 'https://github.com/org/repo/pull/354#discussion_r2',
      created_at: '2026-09-07T05:01:00Z',
    };
    const listPullRequestReviews = vi.fn(async () =>
      searchPolls <= 2 ? [baselineReview] : [baselineReview, newReview],
    );
    const listPullRequestReviewComments = vi.fn(async () =>
      searchPolls <= 2
        ? [baselineReviewComment]
        : [baselineReviewComment, newReviewComment],
    );
    const getStatusCheckRollup = vi.fn(async () =>
      searchPolls <= 2
        ? [{ name: 'build', status: 'IN_PROGRESS', conclusion: null, headSha: 'sha-1' }]
        : [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: 'sha-1' }],
    );
    const githubClient: GitHubClient = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
      getIssue: vi.fn(),
      listIssueComments: vi.fn().mockResolvedValue([]),
      searchLinkedPullRequests: vi.fn(async () => {
        searchPolls += 1;
        if (searchPolls === 1) {
          firstSearchStarted.resolve();
          return firstSearch.promise;
        }
        return [];
      }),
      listPullRequestReviews,
      listPullRequestReviewComments,
      getStatusCheckRollup,
    };

    const { createGitHubMonitor: createRealGitHubMonitor } =
      await vi.importActual<typeof import('../github/github-monitor.js')>(
        '../github/github-monitor.js',
      );
    mockCreateGitHubMonitor.mockImplementation((monitorOptions) => {
      const originalOnCursorChange = monitorOptions.onCursorChange;
      const originalOnUpdate = monitorOptions.onUpdate;
      const monitor = createRealGitHubMonitor({
        ...monitorOptions,
        githubClient,
        onUpdate: (payload) => {
          monitorUpdates.push(payload);
          originalOnUpdate(payload);
        },
        onCursorChange: (cursor) => {
          originalOnCursorChange?.(cursor);
          cursorChanges += 1;
          if (cursorChanges === 2) {
            firstPollCompleted.resolve();
          }
          if (cursorChanges === 3) {
            bootstrapPollCompleted.resolve();
          }
        },
      });
      const originalRegisterPullRequest = monitor.registerPullRequest.bind(monitor);
      monitor.registerPullRequest = vi.fn((registration) => {
        registeredDuringFirstPoll ||= !firstSearchResolved;
        originalRegisterPullRequest(registration);
        registrationCompleted.resolve();
      });
      liveMonitor = monitor;
      return monitor;
    });

    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    mockCreate.mockImplementationOnce(async (agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount += 1;
      if (sendCount === 1) {
        await conductorTools!.register_github_watch!.execute({ prNumber: 354 });
        return {
          runId: 'run-1',
          status: 'finished',
          result: 'registered',
        };
      }
      if (sendCount === 2) {
        githubUpdateMessage.resolve(message);
      }
      return {
        runId: `run-${sendCount}`,
        status: 'finished',
        result: 'handled',
      };
    });

    let sessionPromise: ReturnType<typeof runConductorSession> | undefined;
    try {
      sessionPromise = runConductorSession({
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        ensembleConfig: {
          ...DEFAULT_ENSEMBLE_CONFIG,
          github: {
            ...DEFAULT_ENSEMBLE_CONFIG.github,
            monitor: {
              ...DEFAULT_ENSEMBLE_CONFIG.github.monitor,
              debounceMs: 0,
              pollIntervalMs: 1000,
              activePollIntervalMs: 1000,
            },
          },
        },
        maxTurns: 5,
        permissionPipeline: new PermissionPipeline({}),
        shutdownSignal: shutdown.signal,
        registerProcessSignalHandlers: false,
        waitForOperatorExit: true,
      });

      await firstSearchStarted.promise;
      await drainAsync();
      await registrationCompleted.promise;
      expect(registeredDuringFirstPoll).toBe(true);
      expect(liveMonitor?.registerPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 354 }),
      );

      firstSearchResolved = true;
      firstSearch.resolve([]);
      await firstPollCompleted.promise;
      await drainAsync();

      // Registration requests an immediate poll after the in-flight poll;
      // the following Search-empty poll delivers only new updates.
      await vi.advanceTimersByTimeAsync(1000);
      await drainAsync();
      await bootstrapPollCompleted.promise;
      await drainAsync();
      await vi.advanceTimersByTimeAsync(1000);
      await drainAsync();
      await vi.advanceTimersByTimeAsync(1);
      await drainAsync();
      const updateMessage = await githubUpdateMessage.promise;

      expect(searchPolls).toBe(4);
      expect(githubClient.searchLinkedPullRequests).toHaveBeenCalledTimes(4);
      expect(listPullRequestReviews).toHaveBeenLastCalledWith('org', 'repo', 354);
      expect(listPullRequestReviewComments).toHaveBeenLastCalledWith(
        'org',
        'repo',
        354,
      );
      expect(getStatusCheckRollup).toHaveBeenLastCalledWith('org', 'repo', 354);
      expect(monitorUpdates).toHaveLength(1);
      expect(monitorUpdates[0]?.items.map((item) => item.kind)).toEqual(
        expect.arrayContaining(['pr.review', 'pr.review_comment', 'ci.completed']),
      );
      expect(updateMessage).toContain('## GitHub 更新');
      expect(updateMessage).toContain('kind: pr.review');
      expect(updateMessage).toContain('kind: pr.review_comment');
      expect(updateMessage).toContain('kind: ci.completed');

      const cursor = liveMonitor!.getCursor();
      expect(cursor.explicitPullRequests?.['354']).toMatchObject({
        registeredAt: expect.any(String),
        kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
      });
      expect(cursor.pullRequests?.['354']).toMatchObject({
        lastReviewId: '2',
        lastReviewCommentId: '2',
        lastAggregateBySha: {
          'sha-1': 'completed',
        },
      });

      shutdown.abort();
      await sessionPromise;

      const sidecar = await loadSessionSidecar(
        sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
      );
      expect(sidecar?.githubMonitor?.explicitPullRequests?.['354']).toMatchObject({
        registeredAt: expect.any(String),
        kinds: ['pr.review', 'pr.review_comment', 'ci.completed'],
      });
      expect(sidecar?.githubMonitor?.pullRequests?.['354']).toMatchObject({
        lastReviewId: '2',
        lastReviewCommentId: '2',
        lastAggregateBySha: {
          'sha-1': 'completed',
        },
      });
    } finally {
      firstSearchResolved = true;
      firstSearch.resolve([]);
      shutdown.abort();
      if (sessionPromise) {
        await sessionPromise.catch(() => undefined);
      }
      vi.useRealTimers();
    }
  });

  it('emits auth recovery hint when conductor send returns auth error', async () => {
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => {
      emitted.push(event);
    });

    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'error',
      error: {
        message: 'Authentication error If you are logged in, try logging out and back in.',
      },
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
    });

    expect(result.stopReason).toBe('error');
    expect(mockClose).toHaveBeenCalled();
    expect(
      emitted.some(
        (event) => event.type === 'conductor.auth.reconnect',
      ),
    ).toBe(true);
    expect(
      emitted.some(
        (event) =>
          event.type === 'conductor.auth.recovery' &&
          event.hint.includes('ensemble auth logout'),
      ),
    ).toBe(true);
  });

  it('recovers in-process via resume without auth recovery hint', async () => {
    const projectMcpRoot = join(repoRoot, '.agents');
    await mkdir(projectMcpRoot, { recursive: true });
    await writeFile(
      join(projectMcpRoot, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        },
      }),
    );
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => {
      emitted.push(event);
    });
    const shutdown = new AbortController();
    const mockSendAfterResume = vi.fn().mockResolvedValue({
      runId: 'run-2',
      status: 'running',
      result: 'recovered',
    });

    mockSend.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'error',
      error: { message: 'Authentication error' },
    });
    mockCreate.mockImplementationOnce(async () => ({
      agentId: 'agent-test',
      send: mockSend,
      close: mockClose,
      getUsage: createMockConductorGetUsage(),
    }));
    mockResume.mockImplementation(async () => ({
      agentId: 'agent-test',
      send: mockSendAfterResume,
      close: mockClose,
      getUsage: createMockConductorGetUsage(),
    }));

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      shutdownSignal: shutdown.signal,
      registerProcessSignalHandlers: false,
    });

    await vi.waitFor(() => expect(mockSendAfterResume).toHaveBeenCalled());
    shutdown.abort();
    await sessionPromise;

    expect(
      emitted.some((event) => event.type === 'conductor.auth.recovery'),
    ).toBe(false);
    expect(
      emitted.some(
        (event) => event.type === 'conductor.auth.reconnect',
      ),
    ).toBe(true);
    expect(mockResume).toHaveBeenCalledWith(
      'agent-test',
      expect.objectContaining({
        mcpServers: {
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        },
      }),
    );
  });

  it('emits a Pi provider-specific recovery hint for SDK auth failures', async () => {
    await mkdir(join(repoRoot, '.ensemble', 'pi'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'pi', 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'model-1',
      }),
    );
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    mockSend.mockResolvedValue({
      runId: 'run-pi-auth',
      status: 'error',
      error: { message: 'No API key for provider: anthropic' },
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      ensembleConfig: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: { ...DEFAULT_ENSEMBLE_CONFIG.conductor, backend: 'pi' },
      },
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    const recovery = emitted.find(
      (event): event is Extract<SessionLogEvent, { type: 'conductor.auth.recovery' }> =>
        event.type === 'conductor.auth.recovery',
    );
    expect(recovery?.hint).toContain('provider=anthropic');
    expect(recovery?.hint).toContain('ensemble auth login --provider anthropic');
    expect(recovery?.hint).toContain('~/.ensemble/pi/auth.json');
    expect(recovery?.hint).not.toContain('ensemble auth logout');
  });

  it('recovers transport stalls without auth reconnect or recovery hints', async () => {
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-2',
      status: 'finished',
      result: 'transport recovered',
    });

    mockSend.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'error',
      error: { message: 'Connection stalled repeatedly' },
    });
    mockResume.mockResolvedValue({
      agentId: 'agent-test',
      send: resumedSend,
      close: mockClose,
      getUsage: createMockConductorGetUsage(),
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
    });

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(resumedSend).toHaveBeenCalledWith(
      expect.stringContaining('作業フローの連鎖'),
      expect.any(Object),
    );
    expect(
      emitted
        .filter((event) => event.type === 'conductor.transport.reconnect')
        .map((event) => (event.type === 'conductor.transport.reconnect' ? event.status : '')),
    ).toEqual(['attempt', 'succeeded']);
    expect(emitted.some((event) => event.type === 'conductor.auth.reconnect')).toBe(false);
    expect(emitted.some((event) => event.type === 'conductor.auth.recovery')).toBe(false);
  });

  it('handles /reconnect without sending a conductor message or touching workers', async () => {
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));
    const onPostLoopWait = vi.fn();
    const resumedSend = vi.fn();
    let operatorApi: OperatorInputBindingApi | undefined;

    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    mockResume.mockResolvedValue({
      agentId: 'agent-test',
      send: resumedSend,
      close: mockClose,
      getUsage: createMockConductorGetUsage(),
    });

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    expect(operatorApi!.submit('/reconnect')).toBe(true);
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
    expect(mockSend).toHaveBeenCalledOnce();
    expect(resumedSend).not.toHaveBeenCalled();

    expect(operatorApi!.submit('/exit')).toBe(false);
    await sessionPromise;

    expect(
      emitted
        .filter((event) => event.type === 'conductor.transport.reconnect')
        .map((event) => (event.type === 'conductor.transport.reconnect' ? event.status : '')),
    ).toEqual(['attempt', 'succeeded']);
    expect(emitted.some((event) => event.type === 'operator.input')).toBe(false);
  });

  it('flushes sidecar on shutdown signal while waiting for events', async () => {
    const shutdown = new AbortController();

    mockSend.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'running',
      result: 'still working',
    });

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      shutdownSignal: shutdown.signal,
      registerProcessSignalHandlers: false,
    });

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledOnce());
    shutdown.abort();

    const result = await sessionPromise;
    expect(result.stopReason).toBe('interrupted');

    const sidecar = await loadSessionSidecar(
      sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
    );
    expect(sidecar).toMatchObject({
      conductorAgentId: 'agent-test',
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      sequence: 0,
    });
    expect(sidecar?.updatedAt).toBeGreaterThan(0);
  });

  it.each([
    ['normal completion', 'completed'],
    ['/close', 'completed'],
    ['/exit', 'completed'],
    ['shutdown signal', 'interrupted'],
    ['conductor error', 'error'],
  ] as const)(
    'reports open question persistence failure on %s teardown',
    async (route, expectedStopReason) => {
      const openQuestionsPath = openQuestionsStorePath({
        repoRoot,
        conductorAgentId: 'agent-test',
      });
      // Make the final YAML rename fail after the temporary file is written.
      await mkdir(openQuestionsPath, { recursive: true });

      mockSend.mockResolvedValue({
        runId: 'run-1',
        status:
          route === 'shutdown signal'
            ? 'running'
            : route === 'conductor error'
              ? 'error'
              : 'finished',
        ...(route === 'conductor error'
          ? { error: { message: 'test conductor failure' } }
          : { result: 'done' }),
      });

      const emitted: SessionLogEvent[] = [];
      const sessionLogger = new SessionLogger({
        issueUrl: TEST_ISSUE.url,
        repoRoot,
      });
      sessionLogger.subscribe((event) => emitted.push(event));
      const shutdown = new AbortController();
      const onPostLoopWait = vi.fn();
      let operatorApi: OperatorInputBindingApi | undefined;
      const waitsForOperator = route === '/close' || route === '/exit';

      const sessionPromise = runConductorSession({
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        permissionPipeline: new PermissionPipeline({}),
        sessionLogger,
        registerProcessSignalHandlers: false,
        waitForOperatorExit: waitsForOperator,
        onPostLoopWait,
        shutdownSignal: shutdown.signal,
        bindOperatorInput: (api) => {
          operatorApi = api;
        },
      });

      if (waitsForOperator) {
        await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
        expect(operatorApi).toBeDefined();
        operatorApi!.submit(route);
      } else if (route === 'shutdown signal') {
        await vi.waitFor(() => expect(mockSend).toHaveBeenCalledOnce());
        shutdown.abort();
      }

      const result = await sessionPromise;

      expect(result.stopReason).toBe(expectedStopReason);
      expect(
        emitted.some(
          (event) =>
            event.type === 'harness.warning' &&
            event.message.includes(
              'Open Question YAML / session sidecar を保存できませんでした',
            ),
        ),
      ).toBe(true);
    },
  );

  it('exits immediately after autonomous loop when waitForOperatorExit is false', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalled();
  });

  it('rejects permissions that arrive after teardown starts', async () => {
    const pipeline = new PermissionPipeline({});
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    let workerPermissionHandler: PermissionHandler | undefined;
    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    mockCreate.mockImplementationOnce(async (agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });

    const activePrompt = createDeferred<{ stopReason: string }>();
    const activePromptStarted = vi.fn();
    const lifecycle: string[] = [];
    const cancelSession = vi.fn(() => {
      lifecycle.push('cancel');
      activePrompt.resolve({ stopReason: 'cancelled' });
    });
    const workerClose = vi.fn().mockImplementation(async () => {
      lifecycle.push('close');
    });
    const promptSession = vi.fn(
      async (
        _sessionId: string,
        prompt: string,
        promptOptions?: { permissionHandler?: PermissionHandler },
      ) => {
        workerPermissionHandler = promptOptions?.permissionHandler;
        if (prompt === 'active teardown prompt') {
          activePromptStarted();
          return activePrompt.promise;
        }
        return { stopReason: 'end_turn' };
      },
    );
    const connectAcp = vi.fn(async () =>
      ({
        newSession: vi.fn().mockResolvedValue('worker-session'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession,
        cancelSession,
        close: workerClose,
      }) as unknown as AcpBridge,
    );

    const monitorStopStarted = vi.fn();
    let releaseMonitorStop!: () => void;
    const monitorStop = new Promise<void>((resolve) => {
      releaseMonitorStop = resolve;
    });
    mockCreateGitHubMonitor.mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn().mockImplementation(async () => {
        monitorStopStarted();
        await conductorTools!.prompt_worker!.execute({
          worker: 'implementer',
          instruction: 'active teardown prompt',
        });
        await monitorStop;
      }),
      flush: vi.fn(),
      getCursor: vi.fn().mockReturnValue({
        lastIssueCommentId: undefined,
        pullRequests: {},
      }),
    }));

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      defaultAcp: {
        defaultAcpCommand: process.execPath,
      },
      workerWorktree: {
        path: repoRoot,
        branch: 'main',
        issue: TEST_ISSUE,
        inRepo: true,
      },
      connectAcp,
      permissionPipeline: pipeline,
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    await vi.waitFor(() => expect(monitorStopStarted).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(activePromptStarted).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(workerPermissionHandler).toBeDefined());

    const lateDecision = workerPermissionHandler!({
      sessionId: 'worker-session',
      toolName: 'Shell',
      command: 'tmux kill-session -t issue1',
    });
    await expect(lateDecision).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });

    releaseMonitorStop();
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(workerClose).toHaveBeenCalledOnce();
    expect(cancelSession).toHaveBeenCalledOnce();
    expect(lifecycle.indexOf('cancel')).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf('close')).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf('cancel')).toBeLessThan(lifecycle.indexOf('close'));
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.warning' &&
          event.message.includes('permission.rejected reason=teardown'),
      ),
    ).toBe(true);
  });

  it('dispatches a worker permission that arrives immediately after a permission-only turn', async () => {
    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    mockCreate.mockImplementationOnce(async (agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });

    let workerPermissionHandler: PermissionHandler | undefined;
    const promptSession = vi.fn(
      async (
        _sessionId: string,
        _prompt: string,
        promptOptions?: { permissionHandler?: PermissionHandler },
      ) => {
        workerPermissionHandler = promptOptions?.permissionHandler;
        return { stopReason: 'end_turn' };
      },
    );
    const connectAcp = vi.fn(async () =>
      ({
        newSession: vi.fn().mockResolvedValue('worker-session'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession,
        cancelSession: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }) as unknown as AcpBridge,
    );

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    let operatorApi: OperatorInputBindingApi | undefined;
    const permissionIds: string[] = [];
    const permissionDecisions: Array<Promise<PermissionDecision>> = [];
    const requestPermission = () => {
      const decision = workerPermissionHandler!({
        sessionId: 'worker-session',
        toolName: 'Shell',
        command: 'tmux kill-session -t issue320-static',
      });
      permissionDecisions.push(Promise.resolve(decision));
    };
    const onPostLoopWait = vi.fn(requestPermission);

    sessionLogger.subscribe((event) => {
      if (event.type === 'permission.pending') {
        permissionIds.push(event.permission.id);
      }
    });

    let sendCount = 0;
    let permissionSendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount += 1;
      if (sendCount > 1 && message.includes('permission.pending')) {
        expect(message).toContain(
          'operatorSummary: permission.pending worker=implementer tool=Shell cmd=',
        );
        const permissionIndex = permissionSendCount;
        permissionSendCount += 1;
        expect(permissionIds[permissionIndex]).toBeDefined();
        await conductorTools!.resolve_permission!.execute({
          requestId: permissionIds[permissionIndex],
          decision: permissionIndex === 0 ? 'allow' : 'deny',
        });
        await permissionDecisions[permissionIndex];

        if (permissionIndex === 0) {
          // The worker can request the next permission before this conductor
          // turn has returned, so the stop gate must observe its waiter.
          requestPermission();
        } else {
          operatorApi!.submit('/exit');
        }
      }
      return {
        runId: `run-${sendCount}`,
        status: 'finished',
        result: 'permission handled',
      };
    });

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      defaultAcp: {
        defaultAcpCommand: process.execPath,
      },
      workerWorktree: {
        path: repoRoot,
        branch: 'main',
        issue: TEST_ISSUE,
        inRepo: true,
      },
      connectAcp,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      disableGitHubMonitor: true,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(permissionSendCount).toBe(2);
    expect(onPostLoopWait).toHaveBeenCalledOnce();
    expect(permissionIds).toHaveLength(2);
    expect(permissionDecisions).toHaveLength(2);
    await expect(permissionDecisions[0]).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    await expect(permissionDecisions[1]).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
    const postLoopWaitIndex = emitted.findIndex(
      (event) => event.type === 'session.post_loop_wait',
    );
    const stopIndex = emitted.findIndex(
      (event) => event.type === 'session.stop',
    );
    expect(postLoopWaitIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(postLoopWaitIndex);
  });

  it('waits for /exit after autonomous loop when waitForOperatorExit is true', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));
    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      sessionLogger,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    expect(mockClose).not.toHaveBeenCalled();
    expect(emitted.map((event) => event.type)).toContain(
      'session.post_loop_wait',
    );
    expect(emitted.map((event) => event.type)).not.toContain('session.stop');

    operatorApi!.submit('/exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalled();
    const postLoopWaitIndex = emitted.findIndex(
      (event) => event.type === 'session.post_loop_wait',
    );
    const stopIndex = emitted.findIndex(
      (event) => event.type === 'session.stop',
    );
    expect(postLoopWaitIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(postLoopWaitIndex);
  });

  it('resumes autonomous loop when operator sends input during post-loop wait', async () => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'more',
      });

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
    operatorApi!.submit('continue please');
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledTimes(2));

    operatorApi!.submit('exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('removes isolated worktree after post-loop /exit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({ status: 'not_found' });

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      workerWorktree: {
        path: join(repoRoot, '.ensemble', 'worktrees', 'issue-1'),
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    operatorApi!.submit('/exit');
    await sessionPromise;

    expect(removeSpy).toHaveBeenCalledOnce();
    expect(removeSpy).toHaveBeenCalledWith(repoRoot, TEST_ISSUE);
  });

  it('tears down and flushes on /close when usage collection never resolves', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const unresolvedUsage = createDeferred<{
      cost?: { rawCostCents: number; chargedCents: number };
    }>();
    const getUsage = vi.fn(() => unresolvedUsage.promise);
    mockCreate.mockImplementationOnce(async () => ({
      agentId: 'agent-test',
      send: mockSend,
      close: mockClose,
      getUsage,
    }));

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));
    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      sessionLogger,
      disableGitHubMonitor: true,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
    expect(operatorApi!.submit('/close')).toBe(false);
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(getUsage).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual({
      type: 'harness.teardown.phase',
      phase: 'flushSidecar',
    });
    expect(emitted).toContainEqual({
      type: 'harness.teardown.phase',
      phase: 'conductor',
    });
    await expect(
      loadSessionSidecar(
        sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
      ),
    ).resolves.toMatchObject({
      conductorAgentId: 'agent-test',
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
  });

  it('closes with a resumable sidecar and leaves the isolated worktree intact', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    let conductorTools: Parameters<typeof mockCreate>[0]['customTools'];
    mockCreate.mockImplementationOnce(async (agentOptions) => {
      conductorTools = agentOptions.customTools;
      return {
        agentId: 'agent-test',
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
    const firstBridge = {
      newSession: vi.fn().mockResolvedValue('worker-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn().mockResolvedValue({
        stopReason: 'end_turn',
        responseText: 'ready',
      }),
      cancelSession: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const resumedBridge = {
      newSession: vi.fn().mockResolvedValue('unexpected-new-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn().mockResolvedValue({
        stopReason: 'end_turn',
        responseText: 'ready',
      }),
      cancelSession: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const connectAcp = vi
      .fn()
      .mockResolvedValueOnce(firstBridge)
      .mockResolvedValueOnce(resumedBridge);
    mockSend.mockImplementationOnce(async () => {
      await conductorTools!.prompt_worker!.execute({
        worker: 'implementer',
        instruction: 'persist the worker ACP session',
      });
      return {
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      };
    });

    const path = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
    await mkdir(path, { recursive: true });
    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({ status: 'not_found' });
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      defaultAcp: { defaultAcpCommand: process.execPath },
      disableGitHubMonitor: true,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      sessionLogger,
      workerWorktree: {
        path,
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      connectAcp,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
    expect(operatorApi!.submit('/close')).toBe(false);
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(removeSpy).not.toHaveBeenCalled();
    await expect(access(path)).resolves.toBeUndefined();
    await expect(
      loadSessionSidecar(
        sessionSidecarPath({ repoRoot, conductorAgentId: 'agent-test' }),
      ),
    ).resolves.toMatchObject({
      conductorAgentId: 'agent-test',
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      workers: {
        implementer: {
          acpSessionId: 'worker-session',
          acpCwd: path,
        },
      },
    });
    expect(emitted).toContainEqual({ type: 'session.operator_close' });
    expect(emitted).not.toContainEqual({ type: 'session.operator_exit' });
    expect(
      emitted.some(
        (event) => event.type === 'harness.teardown' && event.force === true,
      ),
    ).toBe(true);
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.teardown.phase' && event.phase === 'conductor',
      ),
    ).toBe(true);
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.teardown.phase' && event.phase === 'worktree',
      ),
    ).toBe(false);
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.worktree.removed' ||
          event.type === 'harness.worktree.remove_skipped' ||
          event.type === 'harness.worktree.remove_failed',
      ),
    ).toBe(false);

    expect(firstBridge.close).toHaveBeenCalledOnce();
    expect(connectAcp).toHaveBeenCalledOnce();

    const sendsBeforeContinue = mockSend.mock.calls.length;
    let continuedOperatorApi: OperatorInputBindingApi | undefined;
    const continuedPostLoopWait = vi.fn();
    const continuePromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: 'agent-test',
      defaultAcp: { defaultAcpCommand: process.execPath },
      disableGitHubMonitor: true,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait: continuedPostLoopWait,
      workerWorktree: {
        path,
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      connectAcp,
      bindOperatorInput: (api) => {
        continuedOperatorApi = api;
      },
    });

    await vi.waitFor(() =>
      expect(continuedPostLoopWait).toHaveBeenCalledOnce(),
    );
    expect(connectAcp).toHaveBeenCalledTimes(2);
    expect(connectAcp.mock.calls[1]?.[0].cwd).toBe(path);
    expect(resumedBridge.loadSession).toHaveBeenCalledWith(
      'worker-session',
      path,
      expect.any(Function),
    );
    expect(resumedBridge.newSession).not.toHaveBeenCalled();
    expect(continuedOperatorApi!.submit('/close')).toBe(false);
    const continuedResult = await continuePromise;

    expect(continuedResult.stopReason).toBe('completed');
    expect(resumedBridge.close).toHaveBeenCalledOnce();
    expect(removeSpy).not.toHaveBeenCalled();
    await expect(access(path)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(sendsBeforeContinue + 1);
    const resumedWorkerResult = String(
      mockSend.mock.calls[sendsBeforeContinue]?.[0],
    );
    expect(resumedWorkerResult).toContain('## worker ラウンド完了');
    expect(resumedWorkerResult).toContain('ready');
  });

  it('persists an attached worker session when /close interrupts its first prompt', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const firstPrompt = createDeferred<{
      stopReason: string;
      responseText: string;
    }>();
    const firstBridge = {
      newSession: vi.fn().mockResolvedValue('worker-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn(() => firstPrompt.promise),
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const resumedBridge = {
      newSession: vi.fn().mockResolvedValue('unexpected-new-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: vi.fn().mockResolvedValue({
        stopReason: 'end_turn',
        responseText: 'resumed worker result',
      }),
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const connectAcp = vi
      .fn()
      .mockResolvedValueOnce(firstBridge)
      .mockResolvedValueOnce(resumedBridge);
    const path = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
    await mkdir(path, { recursive: true });
    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({ status: 'not_found' });
    let operatorApi: OperatorInputBindingApi | undefined;
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      defaultAcp: { defaultAcpCommand: process.execPath },
      disableGitHubMonitor: true,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      workerWorktree: {
        path,
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      connectAcp,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(firstBridge.promptSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(operatorApi).toBeDefined());
    expect(operatorApi!.submit('/close')).toBe(false);
    const closeResult = await sessionPromise;

    expect(closeResult.stopReason).toBe('completed');
    expect(firstBridge.cancelSession).toHaveBeenCalledWith('worker-session');
    expect(firstBridge.close).toHaveBeenCalledOnce();
    expect(removeSpy).not.toHaveBeenCalled();
    await expect(access(path)).resolves.toBeUndefined();
    const sidecarPath = sessionSidecarPath({
      repoRoot,
      conductorAgentId: 'agent-test',
    });
    await expect(loadSessionSidecar(sidecarPath)).resolves.toMatchObject({
      workers: {
        implementer: {
          acpSessionId: 'worker-session',
          acpCwd: path,
        },
      },
    });

    // Complete only after force shutdown has removed the resident. Its late
    // result must not be needed to make the sidecar resumable.
    firstPrompt.resolve({
      stopReason: 'cancelled',
      responseText: '',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const sendsBeforeContinue = mockSend.mock.calls.length;
    let continuedOperatorApi: OperatorInputBindingApi | undefined;
    const continuedPostLoopWait = vi.fn();
    const continuePromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: 'agent-test',
      defaultAcp: { defaultAcpCommand: process.execPath },
      disableGitHubMonitor: true,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait: continuedPostLoopWait,
      workerWorktree: {
        path,
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      connectAcp,
      bindOperatorInput: (api) => {
        continuedOperatorApi = api;
      },
    });

    await vi.waitFor(() =>
      expect(continuedPostLoopWait).toHaveBeenCalledOnce(),
    );
    expect(connectAcp).toHaveBeenCalledTimes(2);
    expect(connectAcp.mock.calls[1]?.[0].cwd).toBe(path);
    expect(resumedBridge.loadSession).toHaveBeenCalledWith(
      'worker-session',
      path,
      expect.any(Function),
    );
    expect(resumedBridge.newSession).not.toHaveBeenCalled();
    expect(resumedBridge.promptSession).toHaveBeenCalledWith(
      'worker-session',
      expect.stringContaining('前回の続きです'),
      expect.any(Object),
    );
    expect(mockSend).toHaveBeenCalledTimes(sendsBeforeContinue + 1);
    expect(
      String(mockSend.mock.calls[sendsBeforeContinue]?.[0]),
    ).toContain('resumed worker result');

    expect(continuedOperatorApi!.submit('/close')).toBe(false);
    const continueResult = await continuePromise;
    expect(continueResult.stopReason).toBe('completed');
    expect(resumedBridge.close).toHaveBeenCalledOnce();
    expect(removeSpy).not.toHaveBeenCalled();
    await expect(access(path)).resolves.toBeUndefined();
  });

  it('keeps a GitHub update pending when its send finishes during /close', async () => {
    const payload = issueCommentUpdate('redeliver after close');
    let cursor: GitHubMonitorCursor = {
      lastIssueCommentId: '99',
      pullRequests: {},
    };
    let emitUpdate: ((update: GitHubUpdatePayload) => void) | undefined;
    let changeCursor:
      | ((nextCursor: GitHubMonitorCursor) => void)
      | undefined;
    const acknowledgeUpdates = vi.fn((ids: readonly string[]) => {
      const acknowledged = new Set(ids);
      const pendingUpdates = (cursor.pendingUpdates ?? []).filter(
        (item) => !acknowledged.has(item.id),
      );
      cursor = {
        ...cursor,
        ...(pendingUpdates.length > 0 ? { pendingUpdates } : {}),
      };
      if (pendingUpdates.length === 0) delete cursor.pendingUpdates;
      changeCursor?.(cursor);
    });
    mockCreateGitHubMonitor.mockImplementationOnce((options) => {
      emitUpdate = options.onUpdate;
      changeCursor = options.onCursorChange;
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn(),
        getCursor: vi.fn(() => cursor),
        acknowledgeUpdates,
        unregisterPullRequest: vi.fn(),
      };
    });

    const completingSend = createDeferred<{
      runId: string;
      status: string;
      result: string;
    }>();
    const sendReturned = createDeferred<void>();
    mockSend
      .mockResolvedValueOnce({
        runId: 'initial-run',
        status: 'finished',
        result: 'ready',
      })
      .mockImplementationOnce(async () => {
        const result = await completingSend.promise;
        sendReturned.resolve();
        return result;
      });
    const closeGate = createDeferred<void>();
    mockClose.mockImplementationOnce(() => closeGate.promise);

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn(() => {
      cursor = {
        ...cursor,
        pendingUpdates: payload.items,
      };
      changeCursor?.(cursor);
      emitUpdate?.(payload);
    });
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledTimes(2),
    );
    expect(operatorApi).toBeDefined();
    expect(operatorApi!.submit('/close')).toBe(false);
    const sidecarPath = sessionSidecarPath({
      repoRoot,
      conductorAgentId: 'agent-test',
    });
    await vi.waitFor(async () => {
      await expect(loadSessionSidecar(sidecarPath)).resolves.toMatchObject({
        githubMonitor: {
          pendingUpdates: payload.items,
        },
      });
    });

    completingSend.resolve({
      runId: 'github-update-run',
      status: 'finished',
      result: 'handled',
    });
    await sendReturned.promise;
    await drainAsync();
    expect(acknowledgeUpdates).not.toHaveBeenCalled();

    closeGate.resolve();
    const result = await sessionPromise;
    expect(result.stopReason).toBe('completed');
    await expect(loadSessionSidecar(sidecarPath)).resolves.toMatchObject({
      githubMonitor: {
        pendingUpdates: payload.items,
      },
    });
  });

  it('emits the worktree removal error after post-loop /exit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({
        status: 'failed',
        path: join(repoRoot, '.ensemble', 'worktrees', 'issue-1'),
        branch: 'ensemble/issue-1',
        error: 'git worktree remove failed: lock held',
      });
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      sessionLogger,
      workerWorktree: {
        path: join(repoRoot, '.ensemble', 'worktrees', 'issue-1'),
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    operatorApi!.submit('/exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(removeSpy).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual({
      type: 'harness.worktree.remove_failed',
      path: join(repoRoot, '.ensemble', 'worktrees', 'issue-1'),
      branch: 'ensemble/issue-1',
      error: 'git worktree remove failed: lock held',
    });
  });

  it('keeps a completed result and reports dirty worktree after post-loop /exit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const path = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({
        status: 'skipped_dirty',
        path,
        branch: 'ensemble/issue-1',
      });
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      sessionLogger,
      workerWorktree: {
        path,
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    operatorApi!.submit('/exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(removeSpy).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual({
      type: 'harness.worktree.remove_skipped',
      path,
      branch: 'ensemble/issue-1',
      reason: 'dirty',
    });
  });

  it('keeps a completed result and reports an unexpected worktree cleanup throw', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const path = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
    vi.spyOn(worktreeModule, 'removeWorkerWorktree').mockRejectedValue(
      new Error('worktree metadata unavailable'),
    );
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      sessionLogger,
      workerWorktree: {
        path,
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    operatorApi!.submit('/exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(emitted).toContainEqual({
      type: 'harness.worktree.remove_failed',
      path,
      branch: 'ensemble/issue-1',
      error: 'cleanup threw unexpectedly: worktree metadata unavailable',
    });
  });

  it('does not remove worktree when post-loop wait is interrupted', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const removeSpy = vi
      .spyOn(worktreeModule, 'removeWorkerWorktree')
      .mockResolvedValue({ status: 'not_found' });

    const shutdown = new AbortController();
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      shutdownSignal: shutdown.signal,
      onPostLoopWait,
      workerWorktree: {
        path: join(repoRoot, '.ensemble', 'worktrees', 'issue-1'),
        branch: 'ensemble/issue-1',
        issue: TEST_ISSUE,
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    shutdown.abort();

    const result = await sessionPromise;
    expect(result.stopReason).toBe('interrupted');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('dispatches issue.comment during post-loop wait', async () => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'from github',
      });

    let githubOnUpdate: ((payload: GitHubUpdatePayload) => void) | undefined;
    mockCreateGitHubMonitor.mockImplementation((options) => {
      githubOnUpdate = options.onUpdate;
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn(),
        getCursor: vi.fn().mockReturnValue({ lastIssueCommentId: undefined, pullRequests: {} }),
      };
    });

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
    expect(githubOnUpdate).toBeDefined();
    githubOnUpdate!(issueCommentUpdate('operator question on issue'));

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledTimes(2));

    operatorApi!.submit('/exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it.each<Exclude<GitHubUpdateKind, 'issue.comment'>>([
    'ci.completed',
    'pr.review',
    'pr.review_comment',
  ])('dispatches post-loop %s updates to the conductor', async (kind) => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    let githubOnUpdate: ((payload: GitHubUpdatePayload) => void) | undefined;
    mockCreateGitHubMonitor.mockImplementation((options) => {
      githubOnUpdate = options.onUpdate;
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn(),
        getCursor: vi.fn().mockReturnValue({ lastIssueCommentId: undefined, pullRequests: {} }),
      };
    });

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
    githubOnUpdate!(githubUpdate(kind));

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledTimes(2));
    expect(String(mockSend.mock.calls[1]![0])).toContain('## GitHub 更新');
    expect(String(mockSend.mock.calls[1]![0])).toContain(`${kind} update`);

    operatorApi!.submit('/exit');
    const result = await sessionPromise;
    expect(result.stopReason).toBe('completed');
  });

  it.each<GitHubUpdateKind>([
    'issue.comment',
    'ci.completed',
    'pr.review',
    'pr.review_comment',
  ])('does not dispatch post-loop %s updates after max-turns', async (kind) => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'from github',
      });

    let githubOnUpdate: ((payload: GitHubUpdatePayload) => void) | undefined;
    mockCreateGitHubMonitor.mockImplementation((options) => {
      githubOnUpdate = options.onUpdate;
      return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        flush: vi.fn(),
        getCursor: vi.fn().mockReturnValue({ lastIssueCommentId: undefined, pullRequests: {} }),
      };
    });

    let operatorApi: OperatorInputBindingApi | undefined;
    const onPostLoopWait = vi.fn();

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 2,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      onPostLoopWait,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledOnce());
    githubOnUpdate!(githubUpdate(kind));
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledTimes(2));

    githubOnUpdate!(githubUpdate(kind));
    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalledTimes(2));
    expect(mockSend).toHaveBeenCalledTimes(2);

    operatorApi!.submit('/exit');
    await sessionPromise;
  });

  it('emits session.operator_exit and force teardown on post-loop /exit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => {
      emitted.push(event);
    });

    let operatorApi: OperatorInputBindingApi | undefined;

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      sessionLogger,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(operatorApi).toBeDefined());
    operatorApi!.submit('/exit');
    await sessionPromise;

    expect(
      emitted.some((event) => event.type === 'session.operator_exit'),
    ).toBe(true);
    expect(
      emitted.some(
        (event) => event.type === 'harness.teardown' && event.force === true,
      ),
    ).toBe(true);
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.teardown.phase' && event.phase === 'conductor',
      ),
    ).toBe(true);
    expect(resultStopReason(emitted)).toBe('completed');
  });

  it('emits harness.teardown after post-loop /exit when github monitor stop is slow', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    let releaseMonitorStop: (() => void) | undefined;
    const monitorStopStarted = vi.fn();
    mockCreateGitHubMonitor.mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            monitorStopStarted();
            releaseMonitorStop = resolve;
          }),
      ),
      flush: vi.fn(),
      getCursor: vi.fn().mockReturnValue({
        lastIssueCommentId: undefined,
        pullRequests: {},
      }),
    }));

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    let operatorApi: OperatorInputBindingApi | undefined;

    sessionLogger.subscribe((event) => {
      emitted.push(event);
      if (event.type === 'session.post_loop_wait') {
        operatorApi!.submit('/exit');
      }
    });

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      sessionLogger,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await vi.waitFor(() => expect(monitorStopStarted).toHaveBeenCalledOnce());
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.teardown.phase' && event.phase === 'githubMonitor',
      ),
    ).toBe(true);
    expect(emitted.some((event) => event.type === 'harness.teardown')).toBe(
      false,
    );

    releaseMonitorStop!();
    await sessionPromise;

    expect(
      emitted.some((event) => event.type === 'session.operator_exit'),
    ).toBe(true);
    expect(
      emitted.some(
        (event) => event.type === 'harness.teardown' && event.force === true,
      ),
    ).toBe(true);
    expect(resultStopReason(emitted)).toBe('completed');
  });

  it('exits when /exit arrives synchronously on session.post_loop_wait emit', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    let operatorApi: OperatorInputBindingApi | undefined;

    sessionLogger.subscribe((event) => {
      emitted.push(event);
      if (event.type === 'session.post_loop_wait') {
        operatorApi!.submit('/exit');
      }
    });

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      sessionLogger,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await sessionPromise;

    expect(
      emitted.some((event) => event.type === 'session.operator_exit'),
    ).toBe(true);
    expect(
      emitted.some(
        (event) => event.type === 'harness.teardown' && event.force === true,
      ),
    ).toBe(true);
    expect(resultStopReason(emitted)).toBe('completed');
  });
});

function resultStopReason(events: SessionLogEvent[]): string | undefined {
  return events.find((event) => event.type === 'session.stop')?.stopReason;
}
