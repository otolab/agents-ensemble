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
import { runConductorSession } from './conductor-session.js';

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
});
