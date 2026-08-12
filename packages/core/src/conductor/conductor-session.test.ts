import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as issueContextModule from '../github/issue-context.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import {
  loadSessionSidecar,
  SessionSidecarNotFoundError,
  sessionSidecarPath,
} from '../session/session-sidecar.js';
import { SessionLogger, type SessionLogEvent } from './session/session-logger.js';
import { runConductorSession } from './conductor-session.js';
import type { OperatorInputBindingApi } from './operator-input-binding.js';
import * as worktreeModule from '../worktree/worktree.js';

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

vi.mock('./conductor-agent.js', () => ({
  ConductorAgent: {
    create: mockCreate,
    resume: mockCreate,
  },
}));

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
    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => ({
      agentId: 'agent-test',
      send: mockSend,
      close: mockClose,
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

  it('emits auth recovery hint when conductor send returns auth error', async () => {
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => {
      emitted.push(event);
    });

    mockSend.mockResolvedValueOnce({
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
    expect(
      emitted.some(
        (event) =>
          event.type === 'conductor.auth.recovery' &&
          event.hint.includes('ensemble auth logout'),
      ),
    ).toBe(true);
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
});
