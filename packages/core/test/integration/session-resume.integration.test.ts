import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import {
  SessionLogger,
  type SessionLogEvent,
} from '../../src/conductor/session/session-logger.js';
import {
  attachWorker,
  buildWorkerAttachPrompt,
  runAttachedWorkerPrompt,
} from '../../src/dispatch/attach-worker.js';
import { closeWorkerAcpSession } from '../../src/dispatch/worker-acp-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import type { Profile, ProfileAcpConfig } from '../../src/profile/types.js';
import {
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
} from '../../src/session/session-sidecar.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import { createTestOperatorInputBinding } from '../../src/conductor/testing/test-operator-input-binding.js';
import {
  extractYamlScalar,
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';
import { createMockConductorGetUsage } from '../../src/testing/mock-conductor-get-usage.js';

const RESUME_AGENT_ID = 'agent-resume-test';

// These tests inject an in-process bridge, but runConductorSession still
// validates the resolved ACP spawn before attaching workers. Use a real,
// always-available executable so the test does not require Cursor Agent CLI.
const IN_PROCESS_ACP: ProfileAcpConfig = {
  preset: 'custom',
  command: process.execPath,
};

const PING_PROFILE_BASE: Profile = {
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  acp: IN_PROCESS_ACP,
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

describe('session resume integration', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-resume-'));

    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Resume integration',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue({
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    });

    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockCreate,
    });
    conductorTools = {};
    mockCreate.mockImplementation(async (options, resumeOptions) => {
      conductorTools = (resumeOptions ?? options).customTools ?? {};
      return {
        agentId: RESUME_AGENT_ID,
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores sidecar profile, open questions, and worker session/load on resume', async () => {
    const bridge = await createInProcessAcpBridge();
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');
    const promptSessionSpy = vi.spyOn(bridge, 'promptSession');

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const sessionState = {
      workers: [{ name: 'ping-1', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'ping-1',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const firstDispatch = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);
    loadSessionSpy.mockClear();
    promptSessionSpy.mockClear();

    const sidecarProfile: Profile = {
      ...PING_PROFILE_BASE,
      // Use a different worker name to prove that the sidecar profile, not
      // the profile supplied by the resumed CLI invocation, drives resume.
      workers: [{ name: 'resumed-ping', kind: 'ping' }],
    };

    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: sidecarProfile,
        openQuestions: [
          {
            id: 'inq-resume-1',
            status: 'open',
            question: 'Continue after restart?',
            responseType: 'text',
            source: 'conductor',
            askedAt: Date.now(),
          },
        ],
        sequence: 1,
        workers: {
          'resumed-ping': { acpSessionId: firstDispatch.acpSessionId },
        },
        updatedAt: Date.now(),
      },
    );

    let sendCount = 0;
    mockSend.mockImplementation(async () => {
      sendCount += 1;
      return {
        runId: `run-${sendCount}`,
        status: 'finished',
        result: sendCount >= 2 ? 'conductor-ok' : 'ack',
      };
    });

    const operator = createTestOperatorInputBinding((context) => {
      const question = context.openQuestions.find(
        (entry) => entry.id === 'inq-resume-1',
      );
      return question ? 'yes, continue' : undefined;
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      expect.any(String),
      expect.any(Function),
    );
    expect(promptSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      expect.stringContaining('前回の続き'),
      expect.objectContaining({ permissionHandler: expect.any(Function) }),
    );

    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('yes, continue');
    expect(messages.some((message) => message.includes('Issue #1'))).toBe(false);

    expect(
      result.openQuestions.find((question) => question.id === 'inq-resume-1')
        ?.status,
    ).toBe('answered');
    expect(result.workerDispatches).toHaveLength(1);
    expect(result.workerDispatches[0]?.name).toBe('resumed-ping');
    expect(result.workerDispatches[0]?.acpSessionId).toBe(
      firstDispatch.acpSessionId,
    );
  });

  it('dispatches permission.pending from a resumed worker without an initial send', async () => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
    });
    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const sessionState = {
      workers: [{ name: 'ping-1', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'ping-1',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const firstDispatch = await runAttachedWorkerPrompt(
      attached,
      buildWorkerAttachPrompt(attachOptions, attached.session),
    );
    await closeWorkerAcpSession(attached.session);

    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: PING_PROFILE_BASE,
        openQuestions: [],
        sequence: 0,
        workers: {
          'ping-1': { acpSessionId: firstDispatch.acpSessionId },
        },
        updatedAt: Date.now(),
      },
    );

    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');

    const permissionPipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount += 1;
      if (message.includes('permission 判断待ち')) {
        const requestId = extractYamlScalar(message, 'id');
        expect(requestId).toBeTruthy();
        await conductorTools.resolve_permission!.execute({
          requestId: requestId!,
          decision: 'allow',
        });
        return {
          runId: `run-${sendCount}`,
          status: 'finished',
          result: 'permission resolved',
        };
      }
      if (isWorkerCompletedConductorMessage(message)) {
        return {
          runId: `run-${sendCount}`,
          status: 'finished',
          result: 'conductor-ok',
        };
      }
      throw new Error(`Unexpected resume conductor message: ${message}`);
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => {
      emitted.push(event);
    });
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      sessionLogger,
    });

    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      expect.any(String),
      expect.any(Function),
    );
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'permission.pending',
      permission: expect.objectContaining({
        request: expect.objectContaining({
          sessionId: firstDispatch.acpSessionId,
        }),
      }),
    }));
    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(messages[0]).toContain('permission 判断待ち');
    expect(messages[1]).toContain('worker.completed');
    expect(
      emitted
        .filter((event) => event.type === 'conductor.send.started')
        .some((event) => event.dispatchSource === 'initial'),
    ).toBe(false);
    expect(permissionPipeline.pending.size).toBe(0);
    expect(result.stopReason).toBe('completed');
    expect(result.workerDispatches).toHaveLength(1);
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.teardown.phase' && event.phase === 'workers',
      ),
    ).toBe(true);
  });

  it('restores worker session/load with custom workspace acpCwd on resume', async () => {
    const docsDir = join(repoRoot, 'docs-repo');
    await mkdir(docsDir, { recursive: true });
    const bridge = await createInProcessAcpBridge();
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const workspaceProfile: Profile = {
      agents: { ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } } },
      acp: IN_PROCESS_ACP,
      workers: [
        {
          name: 'librarian',
          kind: 'ping',
          workspace: 'docs-repo',
          resolvedWorkspacePath: docsDir,
        },
      ],
    };
    const sessionState = {
      workers: [{ name: 'librarian', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'librarian',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
      resolvedWorkspacePath: docsDir,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const firstDispatch = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);
    loadSessionSpy.mockClear();

    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: workspaceProfile,
        openQuestions: [],
        sequence: 0,
        workers: {
          librarian: {
            acpSessionId: firstDispatch.acpSessionId,
            acpCwd: docsDir,
          },
        },
        updatedAt: Date.now(),
      },
    );

    mockSend.mockImplementation(async (message: string) => {
      if (isWorkerCompletedConductorMessage(message)) {
        return {
          runId: 'run-workspace-resume',
          status: 'finished',
          result: 'conductor-ok',
        };
      }
      return {
        runId: 'run-workspace-resume-progress',
        status: 'finished',
        result: 'ack',
      };
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: workspaceProfile,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      docsDir,
      expect.any(Function),
    );
  });

  it('fails worker attach on resume when sidecar acpCwd mismatches profile', async () => {
    const docsDir = join(repoRoot, 'docs-repo');
    await mkdir(docsDir, { recursive: true });
    const bridge = await createInProcessAcpBridge();

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const workspaceProfile: Profile = {
      agents: { ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } } },
      acp: IN_PROCESS_ACP,
      workers: [
        {
          name: 'librarian',
          kind: 'ping',
          workspace: 'docs-repo',
          resolvedWorkspacePath: docsDir,
        },
      ],
    };
    const sessionState = {
      workers: [{ name: 'librarian', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'librarian',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
      resolvedWorkspacePath: docsDir,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const firstDispatch = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);

    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: workspaceProfile,
        openQuestions: [],
        sequence: 0,
        workers: {
          librarian: {
            acpSessionId: firstDispatch.acpSessionId,
            acpCwd: join(repoRoot, 'stale-workspace'),
          },
        },
        updatedAt: Date.now(),
      },
    );

    mockSend.mockImplementation(async (message: string) => {
      if (message.includes('## worker 失敗')) {
        return {
          runId: 'run-workspace-mismatch',
          status: 'finished',
          result: 'conductor-ok',
        };
      }
      return {
        runId: 'run-workspace-mismatch-progress',
        status: 'finished',
        result: 'ack',
      };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: workspaceProfile,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(result.workerFailures).toHaveLength(1);
    expect(result.workerFailures[0]?.name).toBe('librarian');
    expect(result.workerFailures[0]?.error).toMatch(/resume cwd mismatch/);
  });
});
