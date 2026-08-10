import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { ensureMaxTurnsOpenQuestion } from '../escalation/enqueue-max-turns-question.js';
import { createOpenQuestionListTools } from '../escalation/open-question-list-tools.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import { fetchIssueContext } from '../github/issue-context.js';
import type { PermissionPolicyRules } from '../permission/permission-policy.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { createResolvePermissionTool } from '../permission/resolve-permission-tool.js';
import type { Profile } from '../profile/types.js';
import { profileWorkersToSessionSpecs, resolveAgentSystemPrompt, sessionStateFromProfile } from '../profile/types.js';
import { WorkerSession } from '../runtime/worker-session.js';
import { createPromptWorkerTool } from '../dispatch/prompt-worker-tool.js';
import type { ConnectWorkerAcpFn } from '../dispatch/worker-acp-session.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  resolveWorkerWorkspace,
  type WorkerWorktreeMode,
  type WorktreeRef,
} from '../worktree/worktree.js';
import { WorkerOutboundQueue } from '../runtime/worker-outbound-queue.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import { compileConductorSystemPrompt } from '../prompt/compile-system-prompt.js';
import { ConductorAgent } from './conductor-agent.js';
import type { ConductorSendResult } from './conductor-agent.js';
import { formatSessionEventForConductor } from './session/format-session-event.js';
import { SessionLogger } from './session/session-logger.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import type { SessionEvent } from './session/session-event.js';
import { isConductorSendEvent } from './session/session-event.js';
import {
  DEFAULT_MAX_ISSUE_TURNS,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
  type IssueLoopStopReason,
} from './issue-loop.js';
import { canDispatchConductorSend, autonomousTurnsAfterConductorSend } from './conductor-session-loop.js';
import {
  assertSessionSidecarMatches,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
  type SessionSidecar,
} from '../session/session-sidecar.js';
import type { OperatorInputBinding, OperatorInputContext } from './operator-input-binding.js';
import { submitOperatorInput } from './submit-operator-input.js';

export type { OperatorInputContext } from './operator-input-binding.js';
export type {
  OperatorInputBinding,
  OperatorInputBindingApi,
} from './operator-input-binding.js';

export interface RunConductorSessionOptions {
  issueUrl: string;
  repoRoot: string;
  conductorCwd?: string;
  /** 作業手順・worker 定義。未指定時は loadProfile でデフォルトを解決する。 */
  profile: Profile;
  profilePath?: string;
  resumeAgentId?: string;
  apiKey?: string;
  modelId?: string;
  maxTurns?: number;
  permissionPolicy?: PermissionPolicyRules;
  permissionPipeline?: PermissionPipeline;
  /** 各ループでオペレータ入力を受け取る（テスト向け・同期）。`bindOperatorInput` 指定時は未使用。 */
  onOperatorInput?: (
    context: OperatorInputContext,
  ) => string | Promise<string | undefined> | undefined;
  /**
   * 非ブロッキングのオペレータ入力。指定時はループをブロックせず `operator.message` をキューへ積む。
   */
  bindOperatorInput?: OperatorInputBinding;
  /**
   * conductor `agent.send` が error でもループを継続する（TTY 等でオペレータが再試行できるとき）。
   * `onOperatorInput` の有無とは独立。非 TTY / CI では false のままにすること。
   */
  continueOnConductorError?: boolean;
  /** integration 等で Fake ACP に差し替える。未指定時は実 `agent acp`。 */
  connectAcp?: ConnectWorkerAcpFn;
  /**
   * Conductor が worker 向け作業ディレクトリをどう用意するか。
   * セッション開始時に 1 回だけ resolve し、全 worker が共有する。
   */
  workerWorktreeMode?: WorkerWorktreeMode;
  /** テスト用。未指定時は `workerWorktreeMode` から resolve する。 */
  workerWorktree?: WorktreeRef;
  /** integration の共有 bridge 注入時は false。 */
  ownsWorkerAcpConnections?: boolean;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
  /** `agent.send` 完了ごと（CLI 進捗ログ等）。 */
  onSendComplete?: (info: {
    sendCount: number;
    runId: string;
    status: ConductorSendResult['status'];
    result?: string;
    error?: ConductorSendResult['error'];
    workerDispatches: number;
    workerFailures: number;
  }) => void;
  onEscalated?: (record: EscalationRecord) => void;
  onOpenQuestionEnqueued?: (question: OpenQuestion) => void;
  /** テスト用。未指定時は内部で生成する。 */
  sessionLogger?: SessionLogger;
  /** テスト用。未指定時は内部 AbortController に SIGINT/SIGTERM を結線する。 */
  shutdownSignal?: AbortSignal;
  /** デフォルト true。`shutdownSignal` 未指定時のみ有効。 */
  registerProcessSignalHandlers?: boolean;
}

export interface ConductorSessionResult {
  agentId: string;
  issueUrl: string;
  repoRoot: string;
  /** 完了した `agent.send` 回数。 */
  sendCount: number;
  stopReason: IssueLoopStopReason;
  lastRunStatus: string;
  lastResult?: string;
  lastError?: { message: string; code?: string };
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  openQuestions: OpenQuestion[];
}

export async function runConductorSession(
  options: RunConductorSessionOptions,
): Promise<ConductorSessionResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_ISSUE_TURNS;
  const sessionLogger =
    options.sessionLogger ??
    new SessionLogger({
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
    });
  attachLegacySessionCallbacks(sessionLogger, options);
  const escalations: EscalationRecord[] = [];
  const openQuestions = new OpenQuestionRegistry();
  const eventQueue = new SessionEventQueue();
  let activeProfile = options.profile;
  const workerSessions = new Map<string, string>();

  if (options.resumeAgentId) {
    const sidecar = await requireSessionSidecarForResume({
      repoRoot: options.repoRoot,
      conductorAgentId: options.resumeAgentId,
    });
    assertSessionSidecarMatches(sidecar, {
      conductorAgentId: options.resumeAgentId,
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
    });
    openQuestions.restore({
      sequence: sidecar.sequence,
      openQuestions: sidecar.openQuestions,
    });
    activeProfile = sidecar.profile;
    for (const [name, worker] of Object.entries(sidecar.workers)) {
      workerSessions.set(name, worker.acpSessionId);
    }
  }

  const ownsShutdownController = !options.shutdownSignal;
  const shutdownController = ownsShutdownController
    ? new AbortController()
    : undefined;
  const shutdownSignal =
    options.shutdownSignal ?? shutdownController!.signal;
  let unregisterProcessSignalHandlers = () => {};
  if (
    ownsShutdownController &&
    options.registerProcessSignalHandlers !== false
  ) {
    const onSignal = () => shutdownController!.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    unregisterProcessSignalHandlers = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  }

  const permissionPipeline =
    options.permissionPipeline ??
    new PermissionPipeline({ policy: options.permissionPolicy });

  let scheduleSidecarFlush = () => {};

  const sessionState = sessionStateFromProfile(activeProfile);

  const issue = parseIssueUrl(options.issueUrl);
  const workers = profileWorkersToSessionSpecs(activeProfile);
  const workerWorktree =
    options.workerWorktree ??
    (workers.length > 0
      ? await resolveWorkerWorkspace(
          options.repoRoot,
          issue,
          options.workerWorktreeMode ?? 'isolated',
        )
      : undefined);

  if (workerWorktree) {
    sessionLogger.emit({
      type: 'harness.worktree',
      path: workerWorktree.path,
      branch: workerWorktree.branch,
      mode: options.workerWorktreeMode ?? 'isolated',
    });
  }

  const workerSession = new WorkerSession({
    issueUrl: options.issueUrl,
    ...(workerWorktree ? { worktree: workerWorktree } : {}),
    workers,
    sessionState,
    restoredWorkerSessions: Object.fromEntries(workerSessions),
    permissionPipeline,
    ...(options.connectAcp ? { connectAcp: options.connectAcp } : {}),
    ...(options.ownsWorkerAcpConnections !== undefined
      ? { ownsWorkerAcpConnections: options.ownsWorkerAcpConnections }
      : {}),
    decidePermission: (request, workerId, requestId) => {
      const outcome = permissionPipeline.evaluate(requestId, workerId, request);
      if (outcome.status === 'resolved') {
        return outcome.decision;
      }
      const pending = permissionPipeline.pending.get(requestId);
      if (pending) {
        eventQueue.enqueue({ type: 'permission.pending', permission: pending });
      }
      return null;
    },
    onWorkerCompleted: (result) => {
      sessionLogger.emit({ type: 'worker.round', dispatch: result });
      workerSessions.set(result.name, result.acpSessionId);
      eventQueue.enqueue({ type: 'worker.completed', result });
      scheduleSidecarFlush();
    },
    onWorkerFailed: (failure) => {
      sessionLogger.emit({ type: 'worker.failed', failure });
      eventQueue.enqueue({ type: 'worker.failed', failure });
    },
  });

  workerSession.bootstrap();

  const recordAnsweredQuestion = (answered: OpenQuestion) => {
    const record = openQuestionToEscalationRecord(answered);
    if (record) {
      escalations.push(record);
      options.onEscalated?.(record);
    }
    scheduleSidecarFlush();
  };

  const askHumanTools = createAskHumanTool({
    registry: openQuestions,
    onEnqueued: (question) => {
      options.onOpenQuestionEnqueued?.(question);
      scheduleSidecarFlush();
    },
  });

  const answerOpenQuestionTools = createAnswerOpenQuestionTool({
    registry: openQuestions,
    onAnswered: recordAnsweredQuestion,
  });

  const openQuestionListTools = createOpenQuestionListTools({
    registry: openQuestions,
  });

  const resolvePermissionTools = createResolvePermissionTool({
    pipeline: permissionPipeline,
    inbox: workerSession.inbox,
  });

  const workerOutboundQueue = new WorkerOutboundQueue((worker, instruction, options) =>
    workerSession.sendWorkerMessage(worker, instruction, options),
  );

  const promptWorkerTools = createPromptWorkerTool({
    outboundQueue: workerOutboundQueue,
    workerNames: activeProfile.workers.map((worker) => worker.name),
  });

  const conductorOptions = {
    cwd: options.conductorCwd ?? process.cwd(),
    apiKey: options.apiKey,
    modelId: options.modelId,
    customTools: {
      ...askHumanTools,
      ...answerOpenQuestionTools,
      ...openQuestionListTools,
      ...resolvePermissionTools,
      ...promptWorkerTools,
    },
  };

  const conductor = options.resumeAgentId
    ? await ConductorAgent.resume(options.resumeAgentId, conductorOptions)
    : await ConductorAgent.create(conductorOptions);

  let flushSidecar: () => Promise<void> = async () => {};
  flushSidecar = async (): Promise<void> => {
    const workers: SessionSidecar['workers'] = {};
    for (const [name, acpSessionId] of workerSessions) {
      workers[name] = { acpSessionId };
    }
    const snapshot = openQuestions.snapshot();
    const sidecar: SessionSidecar = {
      version: SESSION_SIDECAR_VERSION,
      conductorAgentId: conductor.agentId,
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
      profile: structuredClone(activeProfile),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      openQuestions: snapshot.openQuestions,
      sequence: snapshot.sequence,
      workers,
      updatedAt: Date.now(),
    };
    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot: options.repoRoot,
        conductorAgentId: conductor.agentId,
      }),
      sidecar,
    );
  };
  scheduleSidecarFlush = () => {
    void flushSidecar().catch(() => {
      // best-effort persistence
    });
  };

  let lastSendResult: ConductorSendResult = {
    runId: '',
    status: 'finished',
  };
  let sendCount = 0;
  let lastDispatchesThisTurn = 0;
  let stopReason: IssueLoopStopReason = 'completed';
  const continueOnConductorError = options.continueOnConductorError ?? false;
  let autonomousTurns = 0;
  let disposeOperatorInput: (() => void) | undefined;

  if (options.bindOperatorInput) {
    const bindingDispose = options.bindOperatorInput({
      submit: (message) => {
        const received = submitOperatorInput({
          message,
          conductorTurn: sendCount + 1,
          openQuestions,
          escalations,
          eventQueue,
          sessionLogger,
          onEscalated: (record) => options.onEscalated?.(record),
        });
        if (received) {
          scheduleSidecarFlush();
        }
        return received;
      },
      getContext: () => ({
        conductorTurn: sendCount + 1,
        autonomousTurns,
        maxTurns,
        openQuestions: openQuestions.listOpen(),
      }),
    });
    if (typeof bindingDispose === 'function') {
      disposeOperatorInput = bindingDispose;
    }
  }

  try {
    lastSendResult = await runInitialConductorSend({
      options,
      profile: activeProfile,
      conductor,
      workerSession,
      permissionPipeline,
      workerDispatches: sessionLogger.workerDispatches,
      workerFailures: sessionLogger.workerFailures,
      autonomousTurns,
      maxTurns,
      onSendComplete: recordSendComplete,
    });
    autonomousTurns++;

    while (true) {
      if (autonomousTurns >= maxTurns) {
        ensureMaxTurnsOpenQuestion(openQuestions, {
          issueUrl: options.issueUrl,
          autonomousTurns,
          maxTurns,
          turnCount: sendCount,
          workerDispatchCount: sessionLogger.workerDispatches.length,
          workerFailureCount: sessionLogger.workerFailures.length,
          lastResult: lastSendResult.result,
        }, (question) => {
          options.onOpenQuestionEnqueued?.(question);
        });
      }

      if (!options.bindOperatorInput && options.onOperatorInput) {
        if (openQuestions.openCount > 0) {
          const operatorPhase = await collectOperatorInput({
            conductorTurn: sendCount + 1,
            autonomousTurns,
            maxTurns,
            options,
            openQuestions,
            escalations,
            eventQueue,
            sessionLogger,
          });
          if (openQuestions.openCount > 0) {
            continue;
          }
        } else {
          await collectOperatorInput({
            conductorTurn: sendCount + 1,
            autonomousTurns,
            maxTurns,
            options,
            openQuestions,
            escalations,
            eventQueue,
            sessionLogger,
          });
        }
      }

      if (eventQueue.isEmpty() && workerSession.runtime.runningCount === 0) {
        const loopState = buildLoopState({
          autonomousTurns,
          maxTurns,
          lastSendResult,
          dispatchesThisTurn: lastDispatchesThisTurn,
          workerSession,
          permissionPipeline,
          openQuestions,
          continueOnConductorError,
        });
        stopReason = resolveIssueLoopStopReason(loopState);
        if (shouldStopIssueLoop(loopState)) {
          break;
        }
        if (continueOnConductorError && lastSendResult.status === 'error') {
          continue;
        }
      }

      let event: SessionEvent | undefined;
      try {
        event = await eventQueue.waitForSendEvent({
          signal: shutdownSignal,
          accept: (candidate) =>
            canDispatchConductorSend(candidate, autonomousTurns, maxTurns),
        });
      } catch (error) {
        if (isAbortError(error)) {
          stopReason = 'interrupted';
          break;
        }
        throw error;
      }

      if (!event || !isConductorSendEvent(event)) {
        continue;
      }

      lastSendResult = await runEventConductorSend({
        message: formatSessionEventForConductor(event),
        conductor,
        workerDispatches: sessionLogger.workerDispatches,
        workerFailures: sessionLogger.workerFailures,
        sendCount,
        onSendComplete: recordSendComplete,
      });
      autonomousTurns = autonomousTurnsAfterConductorSend(event, autonomousTurns);

      const loopState = buildLoopState({
        autonomousTurns,
        maxTurns,
        lastSendResult,
        dispatchesThisTurn: lastDispatchesThisTurn,
        workerSession,
        permissionPipeline,
        openQuestions,
        continueOnConductorError,
      });
      stopReason = resolveIssueLoopStopReason(loopState);

      if (shouldStopIssueLoop(loopState)) {
        break;
      }
    }

    return buildResult();

    function recordSendComplete(info: {
      sendCount: number;
      runId: string;
      status: ConductorSendResult['status'];
      result?: string;
      error?: ConductorSendResult['error'];
      workerDispatches: number;
      workerFailures: number;
    }): void {
      sendCount = info.sendCount;
      lastDispatchesThisTurn =
        info.workerDispatches + info.workerFailures;
      sessionLogger.emit({
        type: 'conductor.send',
        sendCount: info.sendCount,
        runId: info.runId,
        status: info.status,
        result: info.result,
        error: info.error,
        workerDispatches: info.workerDispatches,
        workerFailures: info.workerFailures,
      });
      scheduleSidecarFlush();
    }

    function buildResult(): ConductorSessionResult {
      sessionLogger.finish(stopReason);
      return sessionLogger.snapshot({
        agentId: conductor.agentId,
        escalations,
        openQuestions: openQuestions.list(),
      });
    }
  } finally {
    disposeOperatorInput?.();
    unregisterProcessSignalHandlers();
    try {
      await flushSidecar();
    } catch {
      // best-effort persistence
    }
    rejectAllPendingPermissions(permissionPipeline, workerSession.inbox);
    await workerSession.stop();
    await conductor.close();
  }
}

function buildLoopState(input: {
  autonomousTurns: number;
  maxTurns: number;
  lastSendResult: ConductorSendResult;
  dispatchesThisTurn: number;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  openQuestions: OpenQuestionRegistry;
  continueOnConductorError: boolean;
}) {
  return {
    autonomousTurns: input.autonomousTurns,
    maxTurns: input.maxTurns,
    lastStatus: input.lastSendResult.status,
    dispatchesThisTurn: input.dispatchesThisTurn,
    runningWorkers: input.workerSession.runtime.runningCount,
    pendingPermissions: input.permissionPipeline.pending.size,
    openQuestions: input.openQuestions.openCount,
    continueOnConductorError: input.continueOnConductorError,
  };
}

function rejectAllPendingPermissions(
  pipeline: PermissionPipeline,
  inbox: WorkerSession['inbox'],
): void {
  for (const pending of [...pipeline.pending.list()]) {
    try {
      pipeline.resolveAndFulfill(inbox, pending.id, false);
    } catch {
      // already resolved
    }
  }
}

function attachLegacySessionCallbacks(
  logger: SessionLogger,
  options: RunConductorSessionOptions,
): void {
  if (
    !options.onSendComplete &&
    !options.onWorkerDispatched &&
    !options.onWorkerFailed
  ) {
    return;
  }

  logger.subscribe((event) => {
    switch (event.type) {
      case 'conductor.send':
        options.onSendComplete?.({
          sendCount: event.sendCount,
          runId: event.runId,
          status: event.status as ConductorSendResult['status'],
          result: event.result,
          error: event.error,
          workerDispatches: event.workerDispatches,
          workerFailures: event.workerFailures,
        });
        break;
      case 'worker.round':
        options.onWorkerDispatched?.(event.dispatch);
        break;
      case 'worker.failed':
        options.onWorkerFailed?.(event.failure);
        break;
    }
  });
}

async function collectOperatorInput(input: {
  conductorTurn: number;
  autonomousTurns: number;
  maxTurns: number;
  options: RunConductorSessionOptions;
  openQuestions: OpenQuestionRegistry;
  escalations: EscalationRecord[];
  eventQueue: SessionEventQueue;
  sessionLogger: SessionLogger;
}): Promise<{ received: boolean }> {
  if (!input.options.onOperatorInput) {
    return { received: false };
  }

  const operatorMessage = await input.options.onOperatorInput({
    conductorTurn: input.conductorTurn,
    autonomousTurns: input.autonomousTurns,
    maxTurns: input.maxTurns,
    openQuestions: input.openQuestions.listOpen(),
  });
  if (!operatorMessage?.trim()) {
    return { received: false };
  }

  const received = submitOperatorInput({
    message: operatorMessage,
    conductorTurn: input.conductorTurn,
    openQuestions: input.openQuestions,
    escalations: input.escalations,
    eventQueue: input.eventQueue,
    sessionLogger: input.sessionLogger,
    onEscalated: (record) => input.options.onEscalated?.(record),
  });

  return { received };
}

async function runInitialConductorSend(input: {
  options: RunConductorSessionOptions;
  profile: Profile;
  conductor: ConductorAgent;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  autonomousTurns: number;
  maxTurns: number;
  onSendComplete: (info: {
    sendCount: number;
    runId: string;
    status: ConductorSendResult['status'];
    result?: string;
    error?: ConductorSendResult['error'];
    workerDispatches: number;
    workerFailures: number;
  }) => void;
}): Promise<ConductorSendResult> {
  await fetchIssueContext(input.options.issueUrl);
  const message = compileConductorSystemPrompt({
    issueUrl: input.options.issueUrl,
    profile: input.profile,
    roleBootstrap: resolveAgentSystemPrompt('conductor', input.profile.agents),
  });

  return runEventConductorSend({
    message,
    conductor: input.conductor,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    sendCount: 0,
    onSendComplete: input.onSendComplete,
  });
}

async function runEventConductorSend(input: {
  message: string;
  conductor: ConductorAgent;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  sendCount: number;
  onSendComplete: (info: {
    sendCount: number;
    runId: string;
    status: ConductorSendResult['status'];
    result?: string;
    error?: ConductorSendResult['error'];
    workerDispatches: number;
    workerFailures: number;
  }) => void;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;

  const sendResult = await input.conductor.send(input.message);

  const workerDispatches = input.workerDispatches.length - workersBefore;
  const workerFailures = input.workerFailures.length - failuresBefore;
  const sendCount = input.sendCount + 1;

  input.onSendComplete({
    sendCount,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    workerDispatches,
    workerFailures,
  });

  return sendResult;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name: string }).name === 'AbortError')
  );
}
