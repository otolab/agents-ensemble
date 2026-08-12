import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { createOpenQuestionListTools } from '../escalation/open-question-list-tools.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import type { PermissionPolicyRules } from '../permission/permission-policy.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { createResolvePermissionTool } from '../permission/resolve-permission-tool.js';
import type { Profile } from '../profile/types.js';
import { profileWorkersToSessionSpecs, sessionStateFromProfile } from '../profile/types.js';
import { WorkerSession } from '../runtime/worker-session.js';
import { createPromptWorkerTool } from '../dispatch/prompt-worker-tool.js';
import type { ConnectWorkerAcpFn } from '../dispatch/worker-acp-session.js';
import { parseIssueUrl, type IssueRef } from '../issue/issue-ref.js';
import {
  resolveWorkerWorkspace,
  removeWorkerWorktree,
  type WorkerWorktreeMode,
  type WorktreeRef,
} from '../worktree/worktree.js';
import { WorkerOutboundQueue } from '../runtime/worker-outbound-queue.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import { ConductorAgent } from './conductor-agent.js';
import type { ConductorSendResult } from './conductor-agent.js';
import { SessionLogger } from './session/session-logger.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import {
  operatorInputMaxTurns,
  resolveMaxTurns,
  type IssueLoopStopReason,
} from './session-policy.js';
import {
  runConductorSessionDriver,
  type ConductorSessionDriverResult,
} from './conductor-session-driver.js';
import { isOperatorExitCommand } from './operator-exit.js';
import { createOperatorPostLoopGate } from './operator-post-loop-gate.js';
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
  /**
   * 非ブロッキングのオペレータ入力。`submit` で `operator.message` をキューへ積む。
   */
  bindOperatorInput?: OperatorInputBinding;
  /**
   * conductor `agent.send` が error でもループを継続する（TTY 等でオペレータが再試行できるとき）。
   * 非 TTY / CI では false のままにすること。
   */
  continueOnConductorError?: boolean;
  /**
   * 自律ループ停止後も harness を維持し、オペレータの `/exit` または追加指示を待つ。
   * CLI の TTY デフォルト。非 TTY / CI では false。
   */
  waitForOperatorExit?: boolean;
  /** `waitForOperatorExit` 時、自律ループ停止直後に呼ぶ（CLI の案内表示等）。 */
  onPostLoopWait?: () => void;
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
  const maxTurns = resolveMaxTurns(options.maxTurns);
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
    spawn: {
      onProcessStdioLine: ({ stream, line, workerName }) => {
        if (stream !== 'stderr') return;
        sessionLogger.emit({
          type: 'worker.process.stderr',
          line,
          stream: 'stderr',
          workerName,
        });
      },
    },
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
    onBootstrapTelemetry: (event) => {
      switch (event.phase) {
        case 'started':
          sessionLogger.emit({
            type: 'harness.worker.bootstrap.started',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
          });
          break;
        case 'completed':
          sessionLogger.emit({
            type: 'harness.worker.bootstrap.completed',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            stopReason: event.stopReason!,
          });
          break;
        case 'failed':
          sessionLogger.emit({
            type: 'harness.worker.bootstrap.failed',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            error: event.error!,
          });
          break;
      }
    },
  });

  workerSession.bootstrap();

  const recordAnsweredQuestion = (answered: OpenQuestion) => {
    const record = openQuestionToEscalationRecord(answered);
    if (record) {
      escalations.push(record);
      sessionLogger.emit({ type: 'escalation.recorded', record });
      options.onEscalated?.(record);
    }
    scheduleSidecarFlush();
  };

  const askHumanTools = createAskHumanTool({
    registry: openQuestions,
    onEnqueued: (question) => {
      sessionLogger.emit({ type: 'open.question.enqueued', question });
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

  let sendCount = 0;
  let stopReason: IssueLoopStopReason = 'completed';
  const continueOnConductorError = options.continueOnConductorError ?? false;
  const waitForOperatorExit = options.waitForOperatorExit ?? false;
  let autonomousTurns = 0;
  let operatorRequestedExit = false;
  let disposeOperatorInput: (() => void) | undefined;
  const postLoopGate = createOperatorPostLoopGate();

  if (options.bindOperatorInput) {
    const bindingDispose = options.bindOperatorInput({
      submit: (message) => {
        if (isOperatorExitCommand(message)) {
          if (postLoopGate.isWaiting()) {
            postLoopGate.notifyExit();
          } else if (shutdownController) {
            shutdownController.abort();
          }
          return false;
        }
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
          if (postLoopGate.isWaiting()) {
            postLoopGate.notifyResume();
          }
        }
        return received;
      },
      getContext: () => ({
        conductorTurn: sendCount + 1,
        autonomousTurns,
        maxTurns: operatorInputMaxTurns(maxTurns),
        openQuestions: openQuestions.listOpen(),
      }),
    });
    if (typeof bindingDispose === 'function') {
      disposeOperatorInput = bindingDispose;
    }
  }

  try {
    let driverResumeState:
      | (Pick<ConductorSessionDriverResult, 'sendCount' | 'autonomousTurns' | 'lastSendResult'> & {
          lastDispatchesThisTurn: number;
        })
      | undefined;

    while (true) {
      const driverResult = await runConductorSessionDriver({
        issueUrl: options.issueUrl,
        profile: activeProfile,
        conductor,
        eventQueue,
        workerSession,
        permissionPipeline,
        openQuestions,
        shutdownSignal,
        maxTurns,
        continueOnConductorError,
        workerDispatches: sessionLogger.workerDispatches,
        workerFailures: sessionLogger.workerFailures,
        onSendComplete: recordSendComplete,
        onOpenQuestionEnqueued: (question) => {
          sessionLogger.emit({ type: 'open.question.enqueued', question });
          options.onOpenQuestionEnqueued?.(question);
        },
        ...(driverResumeState
          ? {
              skipInitialSend: true,
              resumeState: driverResumeState,
            }
          : {}),
      });
      stopReason = driverResult.stopReason;
      sendCount = driverResult.sendCount;
      autonomousTurns = driverResult.autonomousTurns;
      driverResumeState = {
        sendCount: driverResult.sendCount,
        autonomousTurns: driverResult.autonomousTurns,
        lastSendResult: driverResult.lastSendResult,
        lastDispatchesThisTurn: driverResult.lastDispatchesThisTurn,
      };

      if (!waitForOperatorExit || stopReason === 'interrupted') {
        break;
      }

      options.onPostLoopWait?.();
      sessionLogger.emit({ type: 'session.post_loop_wait' });
      const postLoopAction = await postLoopGate.wait(shutdownSignal);
      if (postLoopAction === 'exit' || shutdownSignal.aborted) {
        if (postLoopAction === 'exit') {
          operatorRequestedExit = true;
        }
        if (shutdownSignal.aborted) {
          stopReason = 'interrupted';
        }
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
      autonomousTurns: number;
    }): void {
      sendCount = info.sendCount;
      autonomousTurns = info.autonomousTurns;
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
    if (
      operatorRequestedExit &&
      workerWorktree &&
      !workerWorktree.inRepo
    ) {
      await emitWorktreeRemoval(sessionLogger, options.repoRoot, issue);
    }
  }
}

async function emitWorktreeRemoval(
  sessionLogger: SessionLogger,
  repoRoot: string,
  issue: IssueRef,
): Promise<void> {
  const result = await removeWorkerWorktree(repoRoot, issue);
  switch (result.status) {
    case 'removed':
      sessionLogger.emit({
        type: 'harness.worktree.removed',
        path: result.path,
        branch: result.branch,
      });
      break;
    case 'skipped_dirty':
      sessionLogger.emit({
        type: 'harness.worktree.remove_skipped',
        path: result.path,
        branch: result.branch,
        reason: 'dirty',
      });
      break;
    case 'failed':
      sessionLogger.emit({
        type: 'harness.worktree.remove_failed',
        path: result.path,
        branch: result.branch,
        error: result.error,
      });
      break;
    case 'not_found':
      break;
  }
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
