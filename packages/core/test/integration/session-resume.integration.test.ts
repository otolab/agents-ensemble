import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import {
  attachWorker,
  buildWorkerAttachPrompt,
  runAttachedWorkerPrompt,
} from '../../src/dispatch/attach-worker.js';
import { closeWorkerAcpSession } from '../../src/dispatch/worker-acp-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import type { Profile } from '../../src/profile/types.js';
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

const SIDECAR_MATERIAL_MARKER = 'SIDECAR_PROFILE_MATERIAL_UNIQUE';
const CLI_MATERIAL_MARKER = 'CLI_PROFILE_MATERIAL_UNIQUE';
const RESUME_AGENT_ID = 'agent-resume-test';

const PING_PROFILE_BASE: Profile = {
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

vi.mock('../../src/conductor/conductor-agent.js', () => ({
  ConductorAgent: {
    create: mockCreate,
    resume: mockCreate,
  },
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
    mockCreate.mockImplementation(async () => ({
      agentId: RESUME_AGENT_ID,
      send: mockSend,
      close: mockClose,
    }));
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
      systemPrompt: PING_SYSTEM_PROMPT,
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
      materials: [
        {
          id: 'sidecar-material',
          title: 'Sidecar',
          content: SIDECAR_MATERIAL_MARKER,
        },
      ],
    };
    const cliProfile: Profile = {
      ...PING_PROFILE_BASE,
      materials: [
        {
          id: 'cli-material',
          title: 'CLI',
          content: CLI_MATERIAL_MARKER,
        },
      ],
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
          'ping-1': { acpSessionId: firstDispatch.acpSessionId },
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
      profile: cliProfile,
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

    const initialMessage = String(mockSend.mock.calls[0]![0]);
    expect(initialMessage).toContain(SIDECAR_MATERIAL_MARKER);
    expect(initialMessage).not.toContain(CLI_MATERIAL_MARKER);

    expect(
      result.openQuestions.find((question) => question.id === 'inq-resume-1')
        ?.status,
    ).toBe('answered');
    expect(result.workerDispatches).toHaveLength(1);
    expect(result.workerDispatches[0]?.acpSessionId).toBe(
      firstDispatch.acpSessionId,
    );
  });
});
