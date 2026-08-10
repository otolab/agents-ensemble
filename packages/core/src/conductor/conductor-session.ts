import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { applyOperatorMessage } from '../escalation/apply-operator-message.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { formatOpenQuestionAnsweredReport, joinOperatorInput } from '../escalation/format-registry-update.js';
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
import { SessionEventQueue } from './session/session-event-queue.js';
import type { SessionEvent } from './session/session-event.js';
import { isConductorSendEvent } from './session/session-event.js';
import {
  DEFAULT_MAX_ISSUE_TURNS,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
  type IssueLoopStopReason,
} from './issue-loop.js';
import {
  assertSessionSidecarMatches,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
  type SessionSidecar,
} from '../session/session-sidecar.js';

export interface OperatorInputContext {
  /** これから実行する conductor send 番号（1 始まり）。 */
  conductorTurn: number;
  autonomousTurns: number;
  maxTurns: number;
  openQuestions: OpenQuestion[];
}

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
  /** 各ループでオペレータ入力を受け取る（open question 待ち・自由チャット）。 */
  onOperatorInput?: (
    context: OperatorInputContext,
  ) => string | Promise<string | undefined> | undefined;
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
  const workerDispatches: WorkerDispatchResult[] = [];
  const workerFailures: WorkerFailureRecord[] = [];
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
      workerDispatches.push(result);
      workerSessions.set(result.name, result.acpSessionId);
      eventQueue.enqueue({ type: 'worker.completed', result });
      options.onWorkerDispatched?.(result);
      scheduleSidecarFlush();
    },
    onWorkerFailed: (failure) => {
      workerFailures.push(failure);
      eventQueue.enqueue({ type: 'worker.failed', failure });
      options.onWorkerFailed?.(failure);
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
  const continueOnConductorError = !!options.onOperatorInput;

  try {
    let autonomousTurns = 0;

    lastSendResult = await runInitialConductorSend({
      options,
      profile: activeProfile,
      conductor,
      workerSession,
      permissionPipeline,
      workerDispatches,
      workerFailures,
      autonomousTurns,
      maxTurns,
      onSendComplete: recordSendComplete,
    });
    autonomousTurns++;

    while (true) {
      if (openQuestions.openCount > 0) {
        const operatorPhase = await collectOperatorInput({
          conductorTurn: sendCount + 1,
          autonomousTurns,
          maxTurns,
          options,
          openQuestions,
          escalations,
          eventQueue,
        });
        if (!operatorPhase.received) {
          continue;
        }
        autonomousTurns = 0;
        if (openQuestions.openCount > 0) {
          continue;
        }
      }

      if (autonomousTurns >= maxTurns) {
        ensureMaxTurnsOpenQuestion(openQuestions, {
          issueUrl: options.issueUrl,
          autonomousTurns,
          maxTurns,
          turnCount: sendCount,
          workerDispatchCount: workerDispatches.length,
          workerFailureCount: workerFailures.length,
          lastResult: lastSendResult.result,
        }, (question) => {
          options.onOpenQuestionEnqueued?.(question);
        });
        continue;
      }

      if (openQuestions.openCount === 0 && options.onOperatorInput) {
        const operatorPhase = await collectOperatorInput({
          conductorTurn: sendCount + 1,
          autonomousTurns,
          maxTurns,
          options,
          openQuestions,
          escalations,
          eventQueue,
        });
        if (operatorPhase.received) {
          autonomousTurns = 0;
        }
      }

      let event: SessionEvent | undefined;
      if (eventQueue.isEmpty()) {
        if (workerSession.runtime.runningCount > 0) {
          event = await waitForSessionEvent(eventQueue, shutdownSignal);
        } else {
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
          // worker / permission イベントの到着を待つ（空キューでの busy-spin を避ける）
          event = await waitForSessionEvent(eventQueue, shutdownSignal);
        }
      } else {
        event = eventQueue.dequeue();
      }

      if (!event && shutdownSignal.aborted) {
        stopReason = 'interrupted';
        break;
      }

      if (!event || !isConductorSendEvent(event)) {
        continue;
      }

      lastSendResult = await runEventConductorSend({
        message: formatSessionEventForConductor(event),
        conductor,
        workerDispatches,
        workerFailures,
        sendCount,
        onSendComplete: recordSendComplete,
      });
      autonomousTurns++;

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
      options.onSendComplete?.(info);
      scheduleSidecarFlush();
    }

    function buildResult(): ConductorSessionResult {
      return {
        agentId: conductor.agentId,
        issueUrl: options.issueUrl,
        repoRoot: options.repoRoot,
        sendCount,
        stopReason,
        lastRunStatus: lastSendResult.status,
        lastResult: lastSendResult.result,
        lastError: lastSendResult.error,
        workerDispatches,
        workerFailures,
        escalations,
        openQuestions: openQuestions.list(),
      };
    }
  } finally {
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

async function collectOperatorInput(input: {
  conductorTurn: number;
  autonomousTurns: number;
  maxTurns: number;
  options: RunConductorSessionOptions;
  openQuestions: OpenQuestionRegistry;
  escalations: EscalationRecord[];
  eventQueue: SessionEventQueue;
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

  const applied = applyOperatorMessage(input.openQuestions, operatorMessage);
  const text =
    applied.answered.length > 0
      ? joinOperatorInput([
          applied.generalGuidance,
          ...applied.answered.map(formatOpenQuestionAnsweredReport),
        ])
      : joinOperatorInput([applied.generalGuidance ?? operatorMessage.trim()]);

  for (const answered of applied.answered) {
    recordAnsweredOpenQuestion(input, answered);
  }

  if (text) {
    input.eventQueue.enqueue({ type: 'operator.message', text });
  }

  return { received: !!text };
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

function recordAnsweredOpenQuestion(
  input: {
    escalations: EscalationRecord[];
    options: RunConductorSessionOptions;
  },
  answered: OpenQuestion,
): void {
  const record = openQuestionToEscalationRecord(answered);
  if (record) {
    input.escalations.push(record);
    input.options.onEscalated?.(record);
  }
}

async function waitForSessionEvent(
  eventQueue: SessionEventQueue,
  signal: AbortSignal,
): Promise<SessionEvent | undefined> {
  try {
    return await eventQueue.waitForEvent(signal);
  } catch (error) {
    if (isAbortError(error)) {
      return undefined;
    }
    throw error;
  }
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
