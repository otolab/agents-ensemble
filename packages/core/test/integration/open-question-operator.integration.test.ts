import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import yaml from 'js-yaml';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpBridge } from '../../src/acp/acp-bridge.js';
import { AcpClient } from '../../src/acp/acp-client.js';
import { startFakeAcpServer } from '../../src/acp/testing/fake-acp-server.js';
import { createInProcessStreamPair } from '../../src/acp/testing/stream-pair.js';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import type { OperatorInputBindingApi } from '../../src/conductor/operator-input-binding.js';
import { SessionLogger, type SessionLogEvent } from '../../src/conductor/session/session-logger.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import { MAX_TURNS_OPEN_QUESTION_TEXT } from '../../src/escalation/enqueue-max-turns-question.js';
import type { OpenQuestion } from '../../src/escalation/open-question.js';
import type { Profile } from '../../src/profile/types.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import {
  expectNotLegacyFollowUpPrompt,
  extractYamlScalar,
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';
import { createTestOperatorInputBinding } from '../../src/conductor/testing/test-operator-input-binding.js';
import { createMockConductorGetUsage } from '../../src/testing/mock-conductor-get-usage.js';
import {
  loadOpenQuestionsStore,
  openQuestionsStorePath,
} from '../../src/session/open-questions-store.js';
import {
  loadSessionResumeStore,
  sessionResumeStorePath,
} from '../../src/session/session-resume-store.js';
import {
  OPEN_QUESTION_CONTROL_METHODS,
  sendOpenQuestionControlRequest,
} from '../../src/session/open-question-control.js';
import { permissionRequestFixtures } from '../fixtures/permission-request-fixtures.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const PING_PROFILE: Profile = {
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  workers: [{ name: 'ping-1', kind: 'ping' }],
};

const IMPLEMENTER_PROFILE: Profile = {
  agents: {
    implementer: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  workers: [{ name: 'implementer-1', kind: 'implementer' }],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const {
  mockSend,
  mockCancel,
  mockClose,
  mockCreate,
  mockCreateCursorSdkConductorAgentFactory,
} = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockCancel = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockCreateCursorSdkConductorAgentFactory = vi.fn();
  return {
    mockSend,
    mockCancel,
    mockClose,
    mockCreate,
    mockCreateCursorSdkConductorAgentFactory,
  };
});

let conductorTools: Record<string, SDKCustomTool> = {};

vi.mock('../../src/conductor/cursor-sdk-conductor-agent.js', () => ({
  createCursorSdkConductorAgentFactory: mockCreateCursorSdkConductorAgentFactory,
}));

describe('open question / operator flow integration', () => {
  let isolatedRepoRoot = '';

  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Integration open question',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);

    mockSend.mockReset();
    mockCancel.mockReset().mockResolvedValue(undefined);
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockCreate,
    });
    mockCreate.mockImplementation(async (options) => {
      conductorTools = options.customTools ?? {};
      return {
        agentId: 'agent-test',
        send: mockSend,
        cancel: mockCancel,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (isolatedRepoRoot) {
      await rm(isolatedRepoRoot, { recursive: true, force: true });
      isolatedRepoRoot = '';
    }
  });

  it('serves only the last successful conductor response from the live session UDS', async () => {
    isolatedRepoRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-last-conductor-message-'),
    );
    const firstSendStarted = deferred<void>();
    const finishFirstSend = deferred<void>();
    const secondSendStarted = deferred<void>();
    const finishSecondSend = deferred<void>();
    const failedSendRecorded = deferred<void>();
    const shutdown = new AbortController();
    let sendCount = 0;
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot: isolatedRepoRoot,
    });
    const unsubscribe = sessionLogger.subscribe((event) => {
      if (event.type === 'conductor.send' && event.status === 'error') {
        failedSendRecorded.resolve();
      }
    });

    mockSend.mockImplementation(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        firstSendStarted.resolve();
        await finishFirstSend.promise;
        return {
          runId: 'run-1',
          status: 'finished',
          result: '  first conductor response  ',
        };
      }
      if (sendCount === 3) {
        return {
          runId: 'run-3',
          status: 'error',
          result: 'failed conductor response',
          error: { message: 'send failed' },
        };
      }
      secondSendStarted.resolve();
      await finishSecondSend.promise;
      return {
        runId: 'run-2',
        status: 'finished',
        result: 'second conductor response',
      };
    });

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: isolatedRepoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      continueOnConductorError: true,
      shutdownSignal: shutdown.signal,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      sessionLogger,
    });

    try {
      await firstSendStarted.promise;
      let socketPath: string | undefined;
      await vi.waitFor(async () => {
        const resumeStore = await loadSessionResumeStore(
          sessionResumeStorePath({
            repoRoot: isolatedRepoRoot,
            conductorAgentId: 'agent-test',
          }),
        );
        socketPath = resumeStore?.harnessSocketPath;
        expect(socketPath).toBeTruthy();
      });

      const getLastMessage = () =>
        sendOpenQuestionControlRequest<{
          message: { text: string; at: number; sendCount: number } | null;
        }>(socketPath!, {
          method: OPEN_QUESTION_CONTROL_METHODS.lastConductorMessageGet,
          params: {},
        });

      const sendOperatorMessage = (text: string) =>
        sendOpenQuestionControlRequest<{
          queued: true;
          delivery: 'idle';
        }>(socketPath!, {
          method: OPEN_QUESTION_CONTROL_METHODS.sendMessage,
          params: { text, delivery: 'idle' },
        });

      await expect(getLastMessage()).resolves.toEqual({ message: null });
      finishFirstSend.resolve();
      await vi.waitFor(async () => {
        await expect(getLastMessage()).resolves.toMatchObject({
          message: {
            text: 'first conductor response',
            sendCount: 1,
          },
        });
      });

      await expect(sendOperatorMessage('Please elaborate.')).resolves.toEqual({
        queued: true,
        delivery: 'idle',
      });
      await secondSendStarted.promise;
      const beforeSecondCompletion = await getLastMessage();
      expect(beforeSecondCompletion.message).toMatchObject({
        text: 'first conductor response',
        sendCount: 1,
      });
      expect(beforeSecondCompletion.message?.at).toEqual(expect.any(Number));

      finishSecondSend.resolve();
      await vi.waitFor(async () => {
        await expect(getLastMessage()).resolves.toMatchObject({
          message: {
            text: 'second conductor response',
            sendCount: 2,
          },
        });
      });

      await expect(sendOperatorMessage('Please try once more.')).resolves.toEqual({
        queued: true,
        delivery: 'idle',
      });
      await failedSendRecorded.promise;
      await expect(getLastMessage()).resolves.toMatchObject({
        message: {
          text: 'second conductor response',
          sendCount: 2,
        },
      });
    } finally {
      shutdown.abort();
      await sessionPromise.catch(() => {});
      unsubscribe();
    }
  });

  it('delivers operator answer via event queue after ask_human (not follow-up prompt)', async () => {
    isolatedRepoRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-open-question-'),
    );
    const repoRoot = isolatedRepoRoot;
    mockSend
      .mockImplementationOnce(async () => {
        await conductorTools.ask_human!.execute({
          question: 'Proceed with deploy?',
        });
        return {
          runId: 'run-1',
          status: 'finished',
          result: 'registered open question',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'conductor-ok',
      });

    const operator = createTestOperatorInputBinding((context) => {
      if (context.openQuestions.some((question) => question.id === 'inq-1')) {
        return 'yes, deploy';
      }
      return undefined;
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(String(mockSend.mock.calls[0]![0])).toContain('Issue #1');
    const operatorMessage = String(mockSend.mock.calls[1]![0]);
    expect(operatorMessage).toContain('yes, deploy');
    expectNotLegacyFollowUpPrompt(operatorMessage);

    expect(result.stopReason).toBe('completed');
    expect(
      result.openQuestions.find((question) => question.id === 'inq-1')?.status,
    ).toBe('answered');
    expect(
      await loadOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot,
          conductorAgentId: result.agentId,
        }),
      ),
    ).toEqual({
      sequence: 1,
      openQuestions: result.openQuestions,
    });
    const resumeStore = await loadSessionResumeStore(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: result.agentId,
      }),
    );
    expect(resumeStore?.sequence).toBe(1);
    expect(resumeStore?.openQuestions).toEqual(result.openQuestions);
  });

  it('records free-text operator answers to choice questions in the event queue', async () => {
    mockSend
      .mockImplementationOnce(async () => {
        await conductorTools.ask_human!.execute({
          question: 'Which release approach?',
          responseType: 'choice',
          choices: [
            { id: 'A', label: 'Ship now' },
            { id: 'B', label: 'Wait for review' },
          ],
        });
        return {
          runId: 'run-1',
          status: 'finished',
          result: 'registered choice question',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'conductor-ok',
      });

    const operator = createTestOperatorInputBinding((context) => {
      if (context.openQuestions.some((question) => question.id === 'inq-1')) {
        return 'Release after the compatibility pass.';
      }
      return undefined;
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    const operatorMessage = String(mockSend.mock.calls[1]![0]);
    expect(operatorMessage).toContain('Release after the compatibility pass.');
    expect(operatorMessage).toContain('【open question 回答】inq-1');
    expect(operatorMessage).not.toContain('selectedChoice:');
    expect(result.openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inq-1',
          responseType: 'choice',
          status: 'answered',
          answer: 'Release after the compatibility pass.',
          answeredBy: 'operator',
        }),
      ]),
    );
    expect(
      result.openQuestions.find((question) => question.id === 'inq-1')
        ?.selectedChoice,
    ).toBeUndefined();
  });

  it('resumes after max_turns open question via operator.message event', async () => {
    mockSend
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'still working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'conductor-ok',
      });

    const operator = createTestOperatorInputBinding((context) => {
      if (
        context.openQuestions.some((question) => question.source === 'max_turns')
      ) {
        return 'continue with tests';
      }
      return undefined;
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: { workers: [] },
      maxTurns: 1,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expectNotLegacyFollowUpPrompt(String(mockSend.mock.calls[1]![0]));
    expect(result.openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'max_turns',
          question: MAX_TURNS_OPEN_QUESTION_TEXT,
          status: 'answered',
          answer: 'continue with tests',
        }),
      ]),
    );
  });

  it('holds an idle operator message during conductor send and dispatches it when idle', async () => {
    isolatedRepoRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-idle-operator-message-'),
    );
    let releaseInitialSend!: () => void;
    let markInitialSendStarted!: () => void;
    const initialSendStarted = new Promise<void>((resolve) => {
      markInitialSendStarted = resolve;
    });
    const initialSendFinished = new Promise<void>((resolve) => {
      releaseInitialSend = resolve;
    });
    mockSend
      .mockImplementationOnce(async () => {
        markInitialSendStarted();
        await initialSendFinished;
        return {
          runId: 'run-1',
          status: 'finished',
          result: 'initial turn complete',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'operator message handled',
      });

    let operatorApi: OperatorInputBindingApi | undefined;
    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot: isolatedRepoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));

    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: isolatedRepoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    try {
      await initialSendStarted;
      expect(operatorApi).toBeDefined();
      expect(operatorApi!.submit('wait until the current turn ends', {
        delivery: 'idle',
      })).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockSend).toHaveBeenCalledTimes(1);

      releaseInitialSend();
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
      expect(String(mockSend.mock.calls[1]![0])).toContain(
        'wait until the current turn ends',
      );
      expect(
        emitted.find(
          (event) =>
            event.type === 'operator.input' &&
            event.text === 'wait until the current turn ends',
        ),
      ).toMatchObject({ delivery: 'idle' });

      operatorApi!.submit('/exit');
      await sessionPromise;
    } finally {
      releaseInitialSend();
      operatorApi?.submit('/exit');
      await sessionPromise.catch(() => {});
    }
  });

  it('cancels an active conductor run for interrupt delivery and then sends the message', async () => {
    isolatedRepoRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-interrupt-operator-message-'),
    );
    let releaseInitialSend!: () => void;
    let markInitialSendStarted!: () => void;
    const initialSendStarted = new Promise<void>((resolve) => {
      markInitialSendStarted = resolve;
    });
    const initialSendFinished = new Promise<void>((resolve) => {
      releaseInitialSend = resolve;
    });
    mockSend
      .mockImplementationOnce(async () => {
        markInitialSendStarted();
        await initialSendFinished;
        return {
          runId: 'run-1',
          status: 'cancelled',
          result: 'partial turn',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'interrupt handled',
      });
    mockCancel.mockImplementation(async () => {
      releaseInitialSend();
    });

    let operatorApi: OperatorInputBindingApi | undefined;
    const sessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: isolatedRepoRoot,
      profile: { workers: [] },
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      registerProcessSignalHandlers: false,
      waitForOperatorExit: true,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    try {
      await initialSendStarted;
      expect(operatorApi).toBeDefined();
      expect(
        operatorApi!.submit('stop the current turn and inspect this', {
          delivery: 'interrupt',
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(mockCancel).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
      expect(String(mockSend.mock.calls[1]![0])).toContain(
        'stop the current turn and inspect this',
      );

      operatorApi!.submit('/exit');
      await sessionPromise;
    } finally {
      releaseInitialSend();
      operatorApi?.submit('/exit');
      await sessionPromise.catch(() => {});
    }
  });

  it('sends permission.pending event then resolves via resolve_permission', async () => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
    });

    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount++;
      if (sendCount === 1) {
        return { runId: 'run-1', status: 'finished', result: 'init' };
      }
      if (message.includes('permission 判断待ち')) {
        const requestId = extractYamlScalar(message, 'id');
        expect(requestId).toBeTruthy();
        await conductorTools.resolve_permission!.execute({
          requestId: requestId!,
          decision: 'allow',
        });
        return { runId: 'run-2', status: 'finished', result: 'permission resolved' };
      }
      if (isWorkerCompletedConductorMessage(message)) {
        return { runId: 'run-3', status: 'finished', result: 'conductor-ok' };
      }
      return { runId: `run-${sendCount}`, status: 'finished', result: 'ok' };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: PING_PROFILE,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({
        policy: { allowTools: [], allowReadOnlyTools: false },
      }),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(messages[0]).toContain('Issue #1');
    expect(messages[1]).toContain('permission 判断待ち');
    expect(messages[2]).toContain('```yaml\n# worker.completed');
    expect(messages[2]).toContain('## worker ラウンド完了');
    expect(messages[2]).toContain('source: harness');
    expect(result.workerDispatches).toHaveLength(1);
    expect(result.workerFailures).toHaveLength(0);
    expect(result.stopReason).toBe('completed');
  });

  it('combines prior tool-call updates with full permission params for conductor', async () => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
      permissionParams: permissionRequestFixtures.editPermissionIdOnly,
      toolCallUpdatesBeforePermission:
        permissionRequestFixtures.editPriorToolCallUpdates,
    });

    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount++;
      if (sendCount === 1) {
        return { runId: 'run-init', status: 'finished', result: 'init' };
      }
      if (message.includes('permission 判断待ち')) {
        const yamlStart = message.indexOf('```yaml\n');
        const yamlEnd = message.indexOf('\n```', yamlStart);
        const permissionEvent = yaml.load(
          message.slice(yamlStart + '```yaml\n'.length, yamlEnd),
        ) as {
          id: string;
          workerId: string;
          worker: string;
          request: { raw: Record<string, unknown> };
          brief: {
            toolCallId: string;
            tool: string;
            operation: { kind: string; path?: string; line?: number };
            missing: string[];
          };
        };

        expect(permissionEvent.worker).toBe('implementer');
        expect(permissionEvent.workerId).toBeTruthy();
        expect(permissionEvent.request.raw).toMatchObject({
          sessionId: 'fake-session-1',
          toolCall: { toolCallId: 'call-edit-from-update' },
          options: permissionRequestFixtures.editPermissionIdOnly.options,
          backendExtension: { source: 'permission-rpc' },
        });
        expect(permissionEvent.brief).toEqual({
          toolCallId: 'call-edit-from-update',
          tool: 'Edit',
          operation: {
            kind: 'edit',
            path: '/workspace/agents-ensemble/packages/core/src/example.ts',
            line: 27,
          },
          missing: [],
        });
        expect(permissionEvent.request.raw.toolCall).not.toHaveProperty(
          'locations',
        );

        const snapshot = await conductorTools.get_tool_call!.execute({
          toolCallId: permissionEvent.brief.toolCallId,
        });
        expect(snapshot.structuredContent).toMatchObject({
          workerId: permissionEvent.workerId,
          sessionId: 'fake-session-1',
          toolCall: {
            toolCallId: 'call-edit-from-update',
            kind: 'edit',
            title: 'Edit File',
            status: 'in_progress',
            rawInput: {
              oldString: '<redacted>',
              newString: '<redacted>',
            },
            locations: [
              {
                path: '/workspace/agents-ensemble/packages/core/src/example.ts',
                line: 27,
              },
            ],
          },
        });
        await conductorTools.resolve_permission!.execute({
          requestId: permissionEvent.id,
          decision: 'allow',
        });
        return {
          runId: 'run-permission',
          status: 'finished',
          result: 'permission resolved',
        };
      }
      if (isWorkerCompletedConductorMessage(message)) {
        return { runId: 'run-complete', status: 'finished', result: 'done' };
      }
      return { runId: `run-${sendCount}`, status: 'finished', result: 'ok' };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: IMPLEMENTER_PROFILE,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({
        policy: { allowTools: [], allowReadOnlyTools: false },
      }),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result.workerFailures).toHaveLength(0);
    expect(result.stopReason).toBe('completed');
  });

  it('keeps conductor context while linking a permission yes_no answer', async () => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
      permissionParams: permissionRequestFixtures.editCursorAcpV1.params,
    });

    let pendingId: string | undefined;
    let observedOpenQuestion: OpenQuestion | undefined;
    let askedHuman = false;
    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount++;
      if (sendCount === 1) {
        await conductorTools.prompt_worker!.execute({
          worker: 'implementer-1',
          instruction: 'Perform the requested work.',
        });
        return { runId: 'run-dispatch', status: 'finished', result: 'worker sent' };
      }

      if (message.includes('permission 判断待ち')) {
        const yamlStart = message.indexOf('```yaml\n');
        const yamlEnd = message.indexOf('\n```', yamlStart);
        const permissionEvent = yaml.load(
          message.slice(yamlStart + '```yaml\n'.length, yamlEnd),
        ) as {
          id: string;
          request: { toolName: string };
          operatorSummary: string;
        };
        if (!askedHuman) {
          pendingId = permissionEvent.id;
          expect(pendingId).toBeTruthy();
          const expectedSummary =
            `permission.pending worker=implementer tool=Edit ` +
            'path=/workspace/agents-ensemble/packages/core/src/permission/format-permission-summary-for-operator.ts ' +
            `description="Edit File" id=${pendingId!.slice(0, 8)}...`;
          expect(permissionEvent.request.toolName).toBe('Edit');
          expect(permissionEvent.operatorSummary).toBe(expectedSummary);

          await conductorTools.ask_human!.execute({
            question: 'Should I allow this file edit?',
            responseType: 'yes_no',
            context: 'The Edit permission is waiting.',
            relatedPermissionId: pendingId,
          });
          askedHuman = true;
        } else {
          await conductorTools.resolve_permission!.execute({
            requestId: permissionEvent.id,
            decision: 'deny',
          });
        }
        return {
          runId: 'run-ask-human',
          status: 'finished',
          result: 'permission question registered',
        };
      }

      if (message.includes('【open question 回答】')) {
        await conductorTools.resolve_permission!.execute({
          requestId: pendingId,
          decision: 'deny',
        });
        return { runId: 'run-deny-permission', status: 'finished', result: 'denied' };
      }

      return { runId: `run-${sendCount}`, status: 'finished', result: 'ok' };
    });

    let operatorAnswered = false;
    const operator = createTestOperatorInputBinding((context) => {
      observedOpenQuestion = context.openQuestions.find(
        (question) => question.relatedPermissionId === pendingId,
      );
      if (observedOpenQuestion && !operatorAnswered) {
        operatorAnswered = true;
        return 'no';
      }
      return undefined;
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: IMPLEMENTER_PROFILE,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({
        policy: { allowTools: [], allowReadOnlyTools: false },
      }),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
    });

    expect(pendingId).toBeTruthy();
    const expectedSummary =
      `permission.pending worker=implementer tool=Edit ` +
      'path=/workspace/agents-ensemble/packages/core/src/permission/format-permission-summary-for-operator.ts ' +
      `description="Edit File" id=${pendingId!.slice(0, 8)}...`;
    expect(observedOpenQuestion).toMatchObject({
      relatedPermissionId: pendingId,
      context: 'The Edit permission is waiting.',
    });
    expect(result.openQuestions).toContainEqual(
      expect.objectContaining({
        relatedPermissionId: pendingId,
        context: 'The Edit permission is waiting.',
        answer: 'no',
        assent: 'no',
        approved: false,
      }),
    );
  });

  it('continues with worker.failed after ACP fails during pending permission', async () => {
    const streams = createInProcessStreamPair();
    let permissionResponse: unknown;
    const fakeServer = startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
      permissionOptions: [{ optionId: 'backend-deny', kind: 'reject_once' }],
      onPermissionResponse: (response) => {
        permissionResponse = response;
      },
    });
    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    await client.connect();

    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    let pendingId: string | undefined;
    let workerFailureMessage: string | undefined;
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
    });
    const events: SessionLogEvent[] = [];
    sessionLogger.subscribe((event) => events.push(event));
    mockSend.mockImplementation(async (message: string) => {
      if (message.includes('permission 判断待ち')) {
        pendingId = extractYamlScalar(message, 'id');
        streams.clientReadable.destroy(new Error('ACP quota exceeded'));
        return {
          runId: 'run-permission',
          status: 'finished',
          result: 'permission interrupted',
        };
      }
      if (message.includes('## worker 失敗')) {
        workerFailureMessage = message;
        return {
          runId: 'run-failure',
          status: 'finished',
          result: 'conductor handled worker failure',
        };
      }
      return {
        runId: 'run-initial',
        status: 'finished',
        result: 'initial',
      };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: PING_PROFILE,
      maxTurns: 10,
      permissionPipeline: pipeline,
      sessionLogger,
      connectAcp: async () => AcpBridge.fromClient(client),
      ownsWorkerAcpConnections: true,
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
    });

    expect(workerFailureMessage).toContain('## worker 失敗');
    expect(workerFailureMessage).toContain('ACP quota exceeded');
    expect(result.workerFailures).toEqual([
      expect.objectContaining({
        error: 'ACP quota exceeded',
      }),
    ]);
    expect(result.lastResult).toBe('conductor handled worker failure');
    expect(pipeline.pending.size).toBe(0);
    expect(pendingId).toBeTruthy();
    expect(
      events
        .filter(
          (event) =>
            event.type === 'permission.pending' ||
            event.type === 'permission.cleanup' ||
            event.type === 'worker.failed',
        )
        .map((event) => event.type),
    ).toEqual(['permission.pending', 'permission.cleanup', 'worker.failed']);
    const cleanup = events.find((event) => event.type === 'permission.cleanup');
    expect(cleanup).toMatchObject({
      reason: 'worker.failed',
      entries: [{ id: pendingId }],
    });
    await expect(
      conductorTools.resolve_permission!.execute({
        requestId: pendingId!,
        decision: 'deny',
      }),
    ).rejects.toThrow(
      'Unknown pending permission (already resolved or worker failed)',
    );
    await vi.waitFor(() => {
      expect(permissionResponse).toEqual({
        outcome: { outcome: 'selected', optionId: 'backend-deny' },
      });
    });

    fakeServer.stop();
  });
});
