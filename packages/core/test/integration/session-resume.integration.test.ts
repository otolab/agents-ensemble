import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import yaml from 'js-yaml';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import {
  SessionLogger,
  type SessionLogEvent,
} from '../../src/conductor/session/session-logger.js';
import type { OperatorInputBindingApi } from '../../src/conductor/operator-input-binding.js';
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
  saveSessionResumeState,
  SESSION_RESUME_STATE_VERSION,
  sessionResumeStorePath,
} from '../../src/session/session-resume-store.js';
import {
  loadOpenQuestionsStore,
  openQuestionsStorePath,
  saveOpenQuestionsStore,
} from '../../src/session/open-questions-store.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  IN_PROCESS_DEFAULT_ACP,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import { createTestOperatorInputBinding } from '../../src/conductor/testing/test-operator-input-binding.js';
import type { OperatorInputBinding } from '../../src/conductor/operator-input-binding.js';
import {
  extractYamlScalar,
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';
import { createMockConductorGetUsage } from '../../src/testing/mock-conductor-get-usage.js';
import { toolCallSnapshotHistoryPath } from '../../src/session/tool-call-snapshot-history.js';
import { TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS } from '../../src/runtime/tool-call-snapshot-registry.js';
import { permissionRequestFixtures } from '../fixtures/permission-request-fixtures.js';

const RESUME_AGENT_ID = 'agent-resume-test';

// These tests inject an in-process bridge, but runConductorSession still
// validates the resolved ACP spawn before attaching workers. Use a real,
// always-available executable so the test does not require Cursor Agent CLI.
const PING_PROFILE_BASE: Profile = {
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
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

  it('restores saved resume state profile, open questions, and worker session/load on resume', async () => {
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

    const resumeStateProfile: Profile = {
      ...PING_PROFILE_BASE,
      // Use a different worker name to prove that the saved resume state profile, not
      // the profile supplied by the resumed CLI invocation, drives resume.
      workers: [{ name: 'resumed-ping', kind: 'ping' }],
    };

    await saveSessionResumeState(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_RESUME_STATE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: resumeStateProfile,
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
    let openQuestionsAtBinding: unknown;
    const bindOperatorInput: OperatorInputBinding = (api) => {
      openQuestionsAtBinding = yaml.load(
        readFileSync(
          openQuestionsStorePath({
            repoRoot,
            conductorAgentId: RESUME_AGENT_ID,
          }),
          'utf8',
        ),
      );
      return operator.bindOperatorInput(api);
    };

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput,
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
    // Resume starts restored workers before the driver, so their completed
    // outcome is queued and delivered after the operator answer.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('yes, continue');
    expect(isWorkerCompletedConductorMessage(messages[1]!)).toBe(true);
    expect(messages.some((message) => message.includes('Issue #1'))).toBe(false);
    expect(openQuestionsAtBinding).toMatchObject({
      version: 1,
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-resume-1',
          status: 'open',
          question: 'Continue after restart?',
        },
      ],
    });

    expect(
      result.openQuestions.find((question) => question.id === 'inq-resume-1')
        ?.status,
    ).toBe('answered');
    expect(result.workerDispatches).toHaveLength(1);
    expect(result.workerDispatches[0]?.name).toBe('resumed-ping');
    expect(result.workerDispatches[0]?.acpSessionId).toBe(
      firstDispatch.acpSessionId,
    );
    expect(
      await loadOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot,
          conductorAgentId: RESUME_AGENT_ID,
        }),
      ),
    ).toEqual({
      sequence: 1,
      openQuestions: result.openQuestions,
    });
  });

  it('prefers open questions YAML over the SessionResumeStore snapshot when resuming', async () => {
    await saveSessionResumeState(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_RESUME_STATE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        openQuestions: [
          {
            id: 'inq-json-1',
            status: 'open',
            question: 'This stale JSON question must not be restored.',
            responseType: 'text',
            source: 'conductor',
            askedAt: 1,
          },
        ],
        sequence: 1,
        workers: {},
        updatedAt: Date.now(),
      },
    );
    await saveOpenQuestionsStore(
      openQuestionsStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        sequence: 8,
        openQuestions: [
          {
            id: 'inq-yaml-8',
            status: 'open',
            question: 'This question came from YAML.',
            responseType: 'text',
            source: 'conductor',
            askedAt: 2,
          },
        ],
      },
    );

    mockSend.mockResolvedValue({
      runId: 'run-yaml-resume',
      status: 'finished',
      result: 'recorded answer',
    });
    const operator = createTestOperatorInputBinding((context) =>
      context.openQuestions.some((question) => question.id === 'inq-yaml-8')
        ? 'answer from YAML'
        : undefined,
    );

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
    });

    expect(mockSend).toHaveBeenCalledOnce();
    expect(String(mockSend.mock.calls[0]?.[0])).toContain('answer from YAML');
    expect(result.openQuestions).toEqual([
      expect.objectContaining({
        id: 'inq-yaml-8',
        question: 'This question came from YAML.',
        status: 'answered',
        answer: 'answer from YAML',
      }),
    ]);
    expect(result.openQuestions).not.toContainEqual(
      expect.objectContaining({ id: 'inq-json-1' }),
    );
    expect(
      await loadOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot,
          conductorAgentId: RESUME_AGENT_ID,
        }),
      ),
    ).toEqual({
      sequence: 8,
      openQuestions: result.openQuestions,
    });
  });

  it('continues resuming when the optional tool-call history is corrupt', async () => {
    const historyPath = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: RESUME_AGENT_ID,
    });
    await saveSessionResumeState(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_RESUME_STATE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: Date.now(),
      },
    );
    await writeFile(historyPath, '{invalid json', 'utf8');
    mockSend.mockResolvedValue({
      runId: 'resume-corrupt-history',
      status: 'finished',
      result: 'resumed',
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      resumeAgentId: RESUME_AGENT_ID,
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      sessionLogger,
    });

    expect(result.stopReason).toBe('completed');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'harness.warning',
        message: expect.stringContaining('history is invalid and was discarded'),
      }),
    );
    await expect(readFile(historyPath, 'utf8')).rejects.toThrow();
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

    await saveSessionResumeState(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_RESUME_STATE_VERSION,
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
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
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

  it('restores tool-call history for permission briefs and lookup after /close and resume', async () => {
    const toolCallUpdates: Array<Record<string, unknown>> =
      permissionRequestFixtures.editPriorToolCallUpdates.map((update) => ({
        ...update,
      }));
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
      permissionParams: permissionRequestFixtures.editPermissionIdOnly,
      toolCallUpdatesBeforePermission: toolCallUpdates,
    });
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');
    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    let phase: 'initial' | 'resume' = 'initial';
    let initialWorkerId: string | undefined;
    const closeForResume = vi.fn().mockResolvedValue(undefined);
    mockCreate.mockImplementation(async (options, resumeOptions) => {
      conductorTools = (resumeOptions ?? options).customTools ?? {};
      return {
        agentId: RESUME_AGENT_ID,
        send: mockSend,
        close: mockClose,
        closeForResume,
        getUsage: createMockConductorGetUsage(),
      };
    });

    mockSend.mockImplementation(async (message: string) => {
      if (message.includes('# permission.pending')) {
        const yamlStart = message.indexOf('```yaml\n');
        const yamlEnd = message.indexOf('\n```', yamlStart);
        const pending = yaml.load(
          message.slice(yamlStart + '```yaml\n'.length, yamlEnd),
        ) as {
          id: string;
          workerId: string;
          request: { raw: Record<string, unknown> };
          brief: {
            toolCallId: string;
            operation: { kind: string; path?: string; line?: number };
            missing: string[];
          };
        };

        if (phase === 'initial') {
          initialWorkerId = pending.workerId;
          expect(pending.brief).toMatchObject({
            toolCallId: 'call-edit-from-update',
            operation: {
              kind: 'edit',
              path: '/workspace/agents-ensemble/packages/core/src/example.ts',
              line: 27,
            },
            missing: [],
          });
          const snapshot = await conductorTools.get_tool_call!.execute({
            toolCallId: pending.brief.toolCallId,
          });
          expect(snapshot.structuredContent).toMatchObject({
            workerId: pending.workerId,
            sessionId: 'fake-session-1',
            toolCall: {
              toolCallId: 'call-edit-from-update',
              status: 'in_progress',
              locations: [
                {
                  path: '/workspace/agents-ensemble/packages/core/src/example.ts',
                  line: 27,
                },
              ],
            },
          });
        } else {
          expect(pending.workerId).not.toBe(initialWorkerId);
          expect(pending.request.raw.sessionId).toBe('fake-session-1');
          expect(pending.brief).toMatchObject({
            toolCallId: 'call-edit-from-update',
            operation: {
              kind: 'edit',
              path: '/workspace/agents-ensemble/packages/core/src/example.ts',
              line: 27,
            },
            missing: [],
          });
          const snapshot = await conductorTools.get_tool_call!.execute({
            toolCallId: pending.brief.toolCallId,
          });
          expect(snapshot.structuredContent).toMatchObject({
            workerId: pending.workerId,
            sessionId: 'fake-session-1',
            toolCall: {
              toolCallId: 'call-edit-from-update',
              status: 'in_progress',
              locations: [
                {
                  path: '/workspace/agents-ensemble/packages/core/src/example.ts',
                  line: 27,
                },
              ],
            },
          });
          const futureSnapshot = await conductorTools.get_tool_call!.execute({
            toolCallId: 'call-future-updated-at',
          });
          expect(futureSnapshot.structuredContent).toMatchObject({
            found: false,
            toolCallId: 'call-future-updated-at',
          });
        }

        await conductorTools.resolve_permission!.execute({
          requestId: pending.id,
          decision: 'allow',
        });
      }
      return {
        runId: `${phase}-run`,
        status: 'finished',
        result: 'ok',
      };
    });

    let firstOperatorApi: OperatorInputBindingApi | undefined;
    const firstPostLoopWait = vi.fn();
    const firstSessionEvents: SessionLogEvent[] = [];
    const firstSessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    firstSessionLogger.subscribe((event) => firstSessionEvents.push(event));
    const firstSessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({}),
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      workerWorktree: worktree,
      waitForOperatorExit: true,
      onPostLoopWait: firstPostLoopWait,
      sessionLogger: firstSessionLogger,
      bindOperatorInput: (api) => {
        firstOperatorApi = api;
      },
    });
    await vi.waitFor(() => expect(firstPostLoopWait).toHaveBeenCalledOnce());
    expect(firstOperatorApi!.submit('/close')).toBe(false);
    const firstResult = await firstSessionPromise;

    expect(firstResult.stopReason).toBe('completed');
    expect(closeForResume).toHaveBeenCalledOnce();
    expect(firstSessionEvents).toContainEqual({ type: 'session.operator_close' });
    expect(initialWorkerId).toBeTruthy();
    const initialPrompt = String(mockSend.mock.calls[0]?.[0] ?? '');
    expect(initialPrompt).toContain('permission 判断待ち');
    expect(initialPrompt).not.toContain('# permission.pending');

    const historyPath = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: RESUME_AGENT_ID,
    });
    const savedHistory = JSON.parse(await readFile(historyPath, 'utf8')) as {
      snapshots: Array<{
        workerId: string;
        workerName: string;
        sessionId: string;
      }>;
    };
    expect(savedHistory.snapshots).toContainEqual(
      expect.objectContaining({
        workerId: initialWorkerId,
        workerName: 'ping-1',
        sessionId: 'fake-session-1',
      }),
    );
    const futureEntry = {
      ...savedHistory.snapshots[0]!,
      updatedAt: Date.now() + 2 * TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
      snapshot: {
        toolCallId: 'call-future-updated-at',
        kind: 'shell',
        rawInput: { command: 'private future command' },
        locations: [{ path: '/private/future/path' }],
      },
    };
    await writeFile(
      historyPath,
      JSON.stringify({
        ...savedHistory,
        snapshots: [...savedHistory.snapshots, futureEntry],
      }),
      'utf8',
    );

    toolCallUpdates.length = 0;
    phase = 'resume';
    const resumedResult = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({}),
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      workerWorktree: worktree,
    });

    expect(resumedResult.stopReason).toBe('completed');
    expect(loadSessionSpy).toHaveBeenCalledWith(
      'fake-session-1',
      expect.any(String),
      expect.any(Function),
    );
    const rewrittenHistory = JSON.parse(await readFile(historyPath, 'utf8')) as {
      snapshots: Array<{
        snapshot: { toolCallId: string };
      }>;
    };
    expect(rewrittenHistory.snapshots).toContainEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          toolCallId: 'call-edit-from-update',
        }),
      }),
    );
    expect(rewrittenHistory.snapshots).not.toContainEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          toolCallId: 'call-future-updated-at',
        }),
      }),
    );
    expect(JSON.stringify(rewrittenHistory)).not.toContain('private future command');
    expect(JSON.stringify(rewrittenHistory)).not.toContain('/private/future/path');
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

    await saveSessionResumeState(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_RESUME_STATE_VERSION,
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
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
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

  it('fails worker attach on resume when saved resume state acpCwd mismatches profile', async () => {
    const docsDir = join(repoRoot, 'docs-repo');
    await mkdir(docsDir, { recursive: true });
    const bridge = await createInProcessAcpBridge();

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const workspaceProfile: Profile = {
      agents: { ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } } },
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

    await saveSessionResumeState(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: RESUME_AGENT_ID,
      }),
      {
        version: SESSION_RESUME_STATE_VERSION,
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
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
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
