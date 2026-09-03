import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as issueContextModule from '../github/issue-context.js';
import * as resolveGitHubAuthTokenModule from '../github/resolve-github-auth-token.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import {
  loadSessionSidecar,
  saveSessionSidecar,
  SessionSidecarNotFoundError,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
} from '../session/session-sidecar.js';
import { SessionLogger, type SessionLogEvent } from './session/session-logger.js';
import { runConductorSession } from './conductor-session.js';
import type { OperatorInputBindingApi } from './operator-input-binding.js';
import * as worktreeModule from '../worktree/worktree.js';
import type {
  GitHubUpdateKind,
  GitHubUpdatePayload,
} from '../github/github-update-types.js';
import { createMockConductorGetUsage } from '../testing/mock-conductor-get-usage.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

const { mockSend, mockClose, mockCreate, mockResume } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockResume = vi.fn();
  return { mockSend, mockClose, mockCreate, mockResume };
});

vi.mock('./conductor-agent.js', () => ({
  ConductorAgent: {
    create: mockCreate,
    resume: mockResume,
  },
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

describe('runConductorSession resume / shutdown', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-conductor-'));

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
      onUpdate: options.onUpdate,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
        mcpServers: expect.objectContaining({
          projectDocs: {
            type: 'http',
            url: 'https://example.test/mcp',
          },
        }),
      }),
    );
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

  it('waits for /exit after autonomous loop when waitForOperatorExit is true', async () => {
    mockSend.mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
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

    await vi.waitFor(() => expect(onPostLoopWait).toHaveBeenCalled());
    expect(mockClose).not.toHaveBeenCalled();

    operatorApi!.submit('/exit');
    const result = await sessionPromise;

    expect(result.stopReason).toBe('completed');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalled();
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
