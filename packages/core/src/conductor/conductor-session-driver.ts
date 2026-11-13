import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ensureMaxTurnsOpenQuestion } from '../escalation/enqueue-max-turns-question.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import type { WorkerSession } from '../runtime/worker-session.js';
import type { ConductorSendResult } from './conductor-agent.js';
import {
  ConductorDispatchLifecycle,
  settleConductorDispatch,
} from './conductor-dispatch-lifecycle.js';
import type {
  ConductorDispatchLease,
  ConductorReconnectLease,
} from './conductor-dispatch-lifecycle.js';
import { ConductorRecoveryInbox } from './conductor-recovery-inbox.js';
import type {
  ConductorRecoveryBackend,
  ConductorRecoveryFailureClass,
  ConductorRecoverySnapshotSummary,
  ConductorRecoveryReservation,
  ConductorRecoveryReconnect,
} from './conductor-recovery-inbox.js';
import type {
  ConductorAgentHandle,
  ConductorReconnectCompleteInfo,
  ConductorSendReconnectOptions,
} from './conductor-send-reconnect.js';
import type { CursorBootstrapState } from './cursor-bootstrap-state.js';
import {
  reconnectConductorAgent,
  sendConductorWithReconnect,
} from './conductor-send-reconnect.js';
import { formatSessionEventsForConductor } from './session/format-session-event.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import type {
  SessionEvent,
} from './session/session-event.js';
import {
  bufferDispatchHoldEvents,
  createDispatchHoldState,
  pruneStalePermissionEvents,
  type DispatchHoldChange,
  type DispatchHoldState,
} from './session/dispatch-hold.js';
import {
  isTriggerSessionEvent,
} from './session/dispatch-mode.js';
import {
  countWorkerOutcomesInBatch,
  dispatchBatchStateAfterSend,
  eventSourceKey,
  markContinuationConsumed,
  selectDispatchBatch,
  type DispatchBatchState,
} from './session/select-dispatch-batch.js';
import {
  autonomousTurnsAfterConductorBatch,
  buildIssueLoopStopInput,
  canDispatchConductorSend,
  isMaxTurnsLimited,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
  type IssueLoopStopReason,
} from './session-policy.js';

export interface ConductorSendStartedInfo {
  /** これから実行する send の通し番号（1 始まり）。 */
  sendCount: number;
  /** dispatch 束の source key（`operator` / `permission` / `permission.stall` / `worker:*` / `conductor.recovery.report` / `initial`）。 */
  dispatchSource?: string;
}

export interface ConductorSendProgressInfo {
  sendCount: number;
  runId: string;
  tool: string;
}

export interface ConductorInboundInfo {
  /** 今回の `agent.send` に束ねた trigger 数。 */
  triggers: number;
  /** 束に含まれる SessionEvent の source key。initial を含む。 */
  sources: string[];
}

export interface ConductorSendCompleteInfo {
  sendCount: number;
  runId: string;
  status: ConductorSendResult['status'];
  /** Exact user message passed to this agent.send. */
  inbound: string;
  /** User event text to retain locally when `inbound` also restores Cursor bootstrap context. */
  historyInbound?: string;
  dispatchSource?: string;
  /** GitHub update IDs included in this send; used to acknowledge the durable outbox. */
  githubUpdateIds?: string[];
  result?: string;
  error?: ConductorSendResult['error'];
  usage?: ConductorSendResult['usage'];
  modelId?: string;
  /** 束内の worker 完了 / 失敗件数（harness 向け）。 */
  workerDispatches: number;
  workerFailures: number;
  /** conductor がこの send で新規 dispatch した worker 件数（ループ停止判定向け）。 */
  conductorDispatchesThisTurn: number;
  autonomousTurns: number;
}

export interface ConductorSessionDriverOptions {
  issueUrl: string;
  /** Compiled system prompt sent as the SDK backend's initial user turn. */
  initialPrompt: string;
  conductorHandle: ConductorAgentHandle;
  sendReconnect: ConductorSendReconnectOptions;
  eventQueue: SessionEventQueue;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  /** PermissionPipeline.pending を dispatch の authoritative source として参照する predicate。 */
  isPermissionPending?: (requestId: string) => boolean;
  openQuestions: OpenQuestionRegistry;
  shutdownSignal: AbortSignal;
  maxTurns: number;
  continueOnConductorError: boolean;
  /** one-shot 入力時は未回答の operator 入力や held trigger の解放を待たずに停止する。 */
  stopOnUnansweredInput?: boolean;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  /** `agent.send` 直前の harness → conductor 境界要約。 */
  onConductorInbound?: (info: ConductorInboundInfo) => void;
  onOperatorQueueChanged?: () => void;
  onOperatorDispatched?: (events: SessionEvent[]) => void;
  onSendStarted?: (info: ConductorSendStartedInfo) => void;
  onSendProgress?: (info: ConductorSendProgressInfo) => void;
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
  onDispatchBatchSettled?: (input: {
    events: SessionEvent[];
    result?: ConductorSendResult;
    error?: unknown;
  }) => void;
  onOpenQuestionEnqueued?: (question: OpenQuestion) => void;
  /** `true` のときは自律ループ停止後もイベントを待ち続ける（TTY post-loop 用）。 */
  continueAfterIssueLoopStop?: boolean;
  /** 自律ループ停止相当の状態へ入ったときに post-loop UX を通知する。 */
  onIssueLoopStop?: () => void;
  /** 既存の conductor 会話を再開するときは初回 `agent.send`（system + ブリーフィング）を省略する。 */
  skipInitialSend?: boolean;
  /** `skipInitialSend` 時に引き継ぐ Driver 状態。 */
  resumeStore?: Pick<
    ConductorSessionDriverResult,
    'sendCount' | 'autonomousTurns' | 'lastSendResult'
  > & { lastDispatchesThisTurn: number };
  /** Cursor の compiled prompt が既存 provider session に bootstrap 済みか。 */
  cursorBootstrapComplete?: boolean;
  /** Cursor resume 中の未知状態を operator が解決するまで dispatch を止める。 */
  cursorBootstrapState?: CursorBootstrapState;
  /** conductor send 中だけ有効な dispatch 保留状態。SessionResumeStore には保存しない。 */
  dispatchHoldState?: DispatchHoldState;
  /** dispatch 保留の切替・件数変化を TUI/観測へ通知する。 */
  onDispatchHoldChanged?: (change: DispatchHoldChange) => void;
  /** conductor send 開始時に outbound dispatch カウンタをリセットする。 */
  resetOutboundDispatchesThisSend?: () => void;
  /** `prompt_worker` 等の outbound dispatch 件数（ループ停止判定向け）。 */
  getOutboundDispatchesThisSend?: () => number;
  /** Process-local, operator-only storage for failed operator-authored input. */
  recoveryInbox?: ConductorRecoveryInbox;
  recoveryBackend?: ConductorRecoveryBackend;
  /** Shared with the local operator binding so `/recovery continue` releases the same gate. */
  dispatchLifecycle?: ConductorDispatchLifecycle<ConductorDispatchPayload>;
  /** Sensitive recovery inspection is available through an interactive TTY binding. */
  operatorCanInspectRecovery?: boolean;
  onRecoveryAttention?: (input: {
    attemptId: string;
    sourceKey: string;
    status: string;
    failureClass: ConductorRecoveryFailureClass;
    confirmationRequired: boolean;
    pendingOperatorMessageCount: number;
    snapshot?: ConductorRecoverySnapshotSummary;
    agentAvailable: boolean;
  }) => void;
  onRecoveryCapacityBlocked?: () => void;
}

export interface ConductorDispatchPayload {
  events: SessionEvent[];
  sourceKey: string;
  operatorInputTexts: string[];
}

type IssueDispatchLease = ConductorDispatchLease<ConductorDispatchPayload>;
type IssueReconnectLease = ConductorReconnectLease;

export interface ConductorSessionDriverResult {
  stopReason: IssueLoopStopReason;
  sendCount: number;
  lastSendResult: ConductorSendResult;
  autonomousTurns: number;
  lastDispatchesThisTurn: number;
}

/**
 * ConductorSession のイベント消費ループ（SessionDriver）。
 * dispatch / stop 判定は SessionPolicy を参照する。
 */
export async function runConductorSessionDriver(
  options: ConductorSessionDriverOptions,
): Promise<ConductorSessionDriverResult> {
  let sendCount = options.resumeStore?.sendCount ?? 0;
  let lastDispatchesThisTurn = options.resumeStore?.lastDispatchesThisTurn ?? 0;
  let autonomousTurns = options.resumeStore?.autonomousTurns ?? 0;
  let dispatchBatchState: DispatchBatchState = {};
  let stopReason: IssueLoopStopReason = 'completed';
  let lastSendResult: ConductorSendResult = options.resumeStore?.lastSendResult ?? {
    runId: '',
    status: 'finished',
  };
  let cursorBootstrapPending =
    options.recoveryBackend === 'cursor' &&
    (options.cursorBootstrapState
      ? options.cursorBootstrapState.status === 'incomplete'
      : options.cursorBootstrapComplete === undefined
        ? !options.skipInitialSend
        : !options.cursorBootstrapComplete);
  let cursorBootstrapCompletedThisDriver = false;
  let inFlightSend: Promise<ConductorSendResult> | undefined;
  let postLoopWaiting = false;
  const lifecycle =
    options.dispatchLifecycle ??
    new ConductorDispatchLifecycle<ConductorDispatchPayload>();
  const recoveryInbox = options.recoveryInbox ?? new ConductorRecoveryInbox();
  const dispatchHoldState =
    options.dispatchHoldState ?? createDispatchHoldState();
  const cursorBootstrapNeedsDecision = (): boolean =>
    options.cursorBootstrapState?.status === 'unknown' ||
    options.cursorBootstrapState?.status === 'saving';
  const isCursorBootstrapPending = (): boolean => {
    if (options.recoveryBackend !== 'cursor') return false;
    if (options.cursorBootstrapState) {
      return (
        options.cursorBootstrapState.status === 'incomplete' &&
        !cursorBootstrapCompletedThisDriver
      );
    }
    return cursorBootstrapPending;
  };
  const markCursorBootstrapCompleted = (): void => {
    cursorBootstrapPending = false;
    cursorBootstrapCompletedThisDriver = true;
  };
  let automaticReconnect: ConductorRecoveryReconnect | undefined;
  const sendReconnect = withAgentAvailabilityCallbacks(
    options.sendReconnect,
    (reason, info) => {
      lifecycle.setAgentAvailable(info.success);
      if (info.source === 'automatic') {
        automaticReconnect = { reason, succeeded: info.success };
      }
    },
  );
  const settleAttempt = (input: {
    lease: IssueDispatchLease;
    events: SessionEvent[];
    sourceKey: string;
    sendCount: number;
    result: ConductorSendResult;
    reservation?: ConductorRecoveryReservation;
    toolCallStarted: boolean;
    requiresConfirmation?: boolean;
  }): void => {
    const outcome = settleConductorDispatch({
      lifecycle,
      lease: input.lease,
      inbox: recoveryInbox,
      ...(input.reservation ? { reservation: input.reservation } : {}),
      workflow: 'issue',
      backend: options.recoveryBackend ?? 'pi',
      sendCount: input.sendCount,
      sourceKey: input.sourceKey,
      eventTypes: input.events.map((event) => event.type),
      operatorInputTexts: input.lease.payload.operatorInputTexts,
      result: input.result,
      ...(automaticReconnect
        ? { automaticReconnect: { ...automaticReconnect } }
        : {}),
      toolCallStarted: input.toolCallStarted,
      captureFailure:
        !options.shutdownSignal.aborted &&
        options.operatorCanInspectRecovery === true,
      ...(input.requiresConfirmation !== undefined
        ? { requiresConfirmation: input.requiresConfirmation }
        : {}),
      ...(input.result.status === 'send_rejected'
        ? { agentAvailable: false }
        : {}),
    });
    automaticReconnect = undefined;
    if (
      !outcome.completed &&
      !options.shutdownSignal.aborted &&
      outcome.failureClass
    ) {
      options.onRecoveryAttention?.({
        attemptId: input.lease.attemptId,
        sourceKey: input.sourceKey,
        status: input.result.status,
        failureClass: outcome.failureClass,
        confirmationRequired: lifecycle.confirmationRequired,
        pendingOperatorMessageCount: options.eventQueue
          .snapshot()
          .filter((event) => event.type === 'operator.message').length,
        ...(outcome.snapshot ? { snapshot: outcome.snapshot } : {}),
        agentAvailable: lifecycle.available,
      });
    }
  };

  const hasDispatchableWorkerOutcome = (): boolean =>
    selectDispatchBatch({
      queue: options.eventQueue.snapshot().filter(
        (event) =>
          event.type === 'worker.completed' || event.type === 'worker.failed',
      ),
      state: dispatchBatchState,
      autonomousTurns,
      maxTurns: options.maxTurns,
    }) !== undefined;

  const shouldBreakAfterLoopState = async (
    loopState: Parameters<typeof shouldStopIssueLoop>[0],
  ): Promise<boolean> => {
    stopReason = resolveIssueLoopStopReason(loopState);
    const shouldStop = shouldStopIssueLoop(loopState);
    // A normal binding may still release and flush held trigger events before
    // stopping. A one-shot has no later operator input to release the hold,
    // so its stop condition must take precedence or the Driver can wait
    // forever. SDK terminal statuses also must not be hidden by the hold.
    const holdBlocksStop =
      dispatchHoldState.heldEvents.length > 0 &&
      options.stopOnUnansweredInput !== true &&
      loopState.lastStatus !== 'error' &&
      loopState.lastStatus !== 'send_rejected' &&
      loopState.lastStatus !== 'cancelled';
    if (
      lifecycle.confirmationRequired &&
      options.operatorCanInspectRecovery !== true
    ) {
      stopReason =
        loopState.lastStatus === 'cancelled' ? 'cancelled' : 'error';
      return true;
    }
    if (holdBlocksStop) {
      postLoopWaiting = false;
      return false;
    }
    if (!shouldStop) {
      postLoopWaiting = false;
      return false;
    }

    if (options.operatorCanInspectRecovery && lifecycle.confirmationRequired) {
      if (!postLoopWaiting) {
        postLoopWaiting = true;
        options.onIssueLoopStop?.();
      }
      return false;
    }

    // A worker publishes its outcome to the inbox before its runtime round
    // leaves the running state. Drain that notification chain before
    // deciding the session is idle, otherwise the driver can tear down in
    // the gap before the outcome reaches eventQueue.
    const canHavePendingWorkerOutcome =
      loopState.lastStatus === 'finished' &&
      loopState.dispatchesThisTurn === 0 &&
      (loopState.pendingPermissions ?? 0) === 0 &&
      (loopState.openQuestions ?? 0) === 0;
    if (canHavePendingWorkerOutcome) {
      await options.workerSession.inbox.drain();
      if (
        hasDispatchableWorkerOutcome() ||
        options.workerSession.runtime.runningCount !== 0
      ) {
        postLoopWaiting = false;
        return false;
      }
    }
    if (!options.continueAfterIssueLoopStop) {
      return true;
    }
    if (!postLoopWaiting) {
      postLoopWaiting = true;
      options.onIssueLoopStop?.();
    }
    return false;
  };

  if (options.cursorBootstrapState && !options.skipInitialSend) {
    try {
      await waitForCursorBootstrapDecision({
        state: options.cursorBootstrapState,
        lifecycle,
        eventQueue: options.eventQueue,
        onOperatorQueueChanged: options.onOperatorQueueChanged,
        signal: options.shutdownSignal,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
      stopReason = 'interrupted';
      return {
        stopReason,
        sendCount,
        lastSendResult,
        autonomousTurns,
        lastDispatchesThisTurn,
      };
    }
  }

  if (!options.skipInitialSend) {
    const initialLease = lifecycle.beginSend({
      events: [],
      sourceKey: 'initial',
      operatorInputTexts: [],
    });
    if (!initialLease) {
      throw new Error('Could not acquire the initial conductor send lease.');
    }
    automaticReconnect = undefined;
    let initialToolCallStarted = false;
    options.onConductorInbound?.({
      triggers: 1,
      sources: ['initial'],
    });
    lastSendResult = await runEventConductorSend({
      // Keep the initial dispatch asynchronous as it was when the driver
      // fetched and compiled the prompt itself.
      message: await Promise.resolve(options.initialPrompt),
      conductorHandle: options.conductorHandle,
      sendReconnect,
      signal: options.shutdownSignal,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      sendCount: 0,
      autonomousTurns: 1,
      dispatchSource: 'initial',
      githubUpdateIds: [],
      resetOutboundDispatchesThisSend: options.resetOutboundDispatchesThisSend,
      getOutboundDispatchesThisSend: options.getOutboundDispatchesThisSend,
      onSendStarted: options.onSendStarted,
      onSendProgress: (info) => {
        initialToolCallStarted = true;
        options.onSendProgress?.(info);
      },
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    }).then((result) => {
      if (
        options.recoveryBackend === 'cursor' &&
        isIssueDispatchCompleted(result)
      ) {
        markCursorBootstrapCompleted();
      }
      const explicitInterruptQueued =
        result.status === 'cancelled' &&
        options.eventQueue.snapshot().some(
          (event) =>
            event.type === 'operator.message' &&
            event.delivery === 'interrupt',
        );
      settleAttempt({
        lease: initialLease,
        events: [],
        sourceKey: 'initial',
        sendCount,
        result,
        toolCallStarted: initialToolCallStarted,
        ...(explicitInterruptQueued ? { requiresConfirmation: false } : {}),
      });
      return result;
    });
  }

  while (true) {
    if (options.shutdownSignal.aborted) {
      stopReason = 'interrupted';
      break;
    }

    if (options.cursorBootstrapState && cursorBootstrapNeedsDecision()) {
      try {
        await waitForCursorBootstrapDecision({
          state: options.cursorBootstrapState,
          lifecycle,
          eventQueue: options.eventQueue,
          onOperatorQueueChanged: options.onOperatorQueueChanged,
          signal: options.shutdownSignal,
        });
      } catch (error) {
        if (!isAbortError(error)) throw error;
        stopReason = 'interrupted';
        break;
      }
      if (options.shutdownSignal.aborted) {
        stopReason = 'interrupted';
        break;
      }
    }

    if (
      lifecycle.confirmationRequired &&
      options.operatorCanInspectRecovery !== true
    ) {
      stopReason =
        lastSendResult.status === 'cancelled' ? 'cancelled' : 'error';
      break;
    }

    if (options.isPermissionPending) {
      pruneStalePermissionEvents({
        state: dispatchHoldState,
        eventQueue: options.eventQueue,
        isPermissionPending: options.isPermissionPending,
        onChanged: options.onDispatchHoldChanged,
      });
    }

    if (
      !inFlightSend &&
      isMaxTurnsLimited(options.maxTurns) &&
      autonomousTurns >= options.maxTurns
    ) {
      ensureMaxTurnsOpenQuestion(options.openQuestions, {
        issueUrl: options.issueUrl,
        autonomousTurns,
        maxTurns: options.maxTurns,
        turnCount: sendCount,
        workerDispatchCount: options.workerDispatches.length,
        workerFailureCount: options.workerFailures.length,
        lastResult: lastSendResult.result,
      }, options.onOpenQuestionEnqueued);
    }

    if (inFlightSend) {
      const awaited = await awaitWithAbort(inFlightSend, options.shutdownSignal);
      if (awaited.aborted) {
        stopReason = 'interrupted';
        break;
      }
      if (options.shutdownSignal.aborted) {
        stopReason = 'interrupted';
        break;
      }
      lastSendResult = awaited.value!;
      inFlightSend = undefined;

      if (
        lastSendResult.status === 'cancelled' &&
        options.eventQueue.snapshot().some(
          (event) =>
            event.type === 'operator.message' &&
            event.delivery === 'interrupt',
        )
      ) {
        // #525's interrupt cancellation ends only this run. The queued operator
        // message is the next dispatch; it does not terminate the session.
        continue;
      }

      const loopState = buildIssueLoopStopInput({
        autonomousTurns,
        maxTurns: options.maxTurns,
        lastSendResult,
        dispatchesThisTurn: lastDispatchesThisTurn,
        workerSession: options.workerSession,
        permissionPipeline: options.permissionPipeline,
        openQuestions: options.openQuestions,
        continueOnConductorError: options.continueOnConductorError,
        stopOnUnansweredInput: options.stopOnUnansweredInput,
      });
      const queuedDispatch = selectDispatchBatch({
        queue: options.eventQueue.snapshot(),
        state: dispatchBatchState,
        autonomousTurns,
        maxTurns: options.maxTurns,
        allowIdleOperatorMessages: canDispatchIdleOperatorMessage({
          eventQueue: options.eventQueue,
          dispatchHoldState,
          workerSession: options.workerSession,
          dispatchBatchState,
          autonomousTurns,
          maxTurns: options.maxTurns,
        }),
      });
      const shouldBreak = await shouldBreakAfterLoopState(loopState);
      const idleOperatorMessageReady = queuedDispatch?.batch.events.some(
        (event) =>
          event.type === 'operator.message' && event.delivery === 'idle',
      );
      if (
        shouldBreak &&
        (!idleOperatorMessageReady ||
          options.stopOnUnansweredInput === true)
      ) {
        break;
      }
      continue;
    }

    const canEvaluateStopWithHeldEvents =
      dispatchHoldState.heldEvents.length === 0 ||
      options.stopOnUnansweredInput === true;
    if (
      options.eventQueue.isEmpty() &&
      options.workerSession.runtime.runningCount === 0 &&
      canEvaluateStopWithHeldEvents
    ) {
      const loopState = buildIssueLoopStopInput({
        autonomousTurns,
        maxTurns: options.maxTurns,
        lastSendResult,
        dispatchesThisTurn: lastDispatchesThisTurn,
        workerSession: options.workerSession,
        permissionPipeline: options.permissionPipeline,
        openQuestions: options.openQuestions,
        continueOnConductorError: options.continueOnConductorError,
        stopOnUnansweredInput: options.stopOnUnansweredInput,
      });
      if (await shouldBreakAfterLoopState(loopState)) {
        break;
      }
    }

    let dispatchResult: DispatchBatchResult | undefined;
    try {
      dispatchResult = await waitForDispatchBatch({
        eventQueue: options.eventQueue,
        dispatchBatchState,
        autonomousTurns,
        maxTurns: options.maxTurns,
        lifecycle,
        recoveryInbox,
        operatorCanInspectRecovery:
          options.operatorCanInspectRecovery === true,
        signal: options.shutdownSignal,
        dispatchHoldState,
        onDispatchHoldChanged: options.onDispatchHoldChanged,
        onOperatorQueueChanged: options.onOperatorQueueChanged,
        onRecoveryCapacityBlocked: options.onRecoveryCapacityBlocked,
        isPermissionPending: options.isPermissionPending,
        canDispatchIdleOperatorMessage: () =>
          canDispatchIdleOperatorMessage({
            eventQueue: options.eventQueue,
            dispatchHoldState,
            workerSession: options.workerSession,
            dispatchBatchState,
            autonomousTurns,
            maxTurns: options.maxTurns,
          }),
      });
    } catch (error) {
      if (isAbortError(error)) {
        stopReason = 'interrupted';
        break;
      }
      throw error;
    }

    if (!dispatchResult) {
      continue;
    }
    if (options.shutdownSignal.aborted) {
      if (dispatchResult.reservation) {
        recoveryInbox.release(dispatchResult.reservation);
      }
      stopReason = 'interrupted';
      break;
    }

    const { events: batch, selected, reservation } = dispatchResult;
    postLoopWaiting = false;

    if (dispatchResult.sourceKey === 'operator.reconnect') {
      const reconnectLease = lifecycle.beginReconnect();
      if (!reconnectLease) continue;
      options.eventQueue.removeEvents(batch);
      if (selected) {
        dispatchBatchState = markContinuationConsumed(
          dispatchBatchState,
          selected,
        );
      }
      dispatchBatchState = dispatchBatchStateAfterSend(dispatchResult.sourceKey);
      const reconnected = await runOperatorReconnect(options);
      lifecycle.settleReconnect(reconnectLease, reconnected);
      if (reconnected && !options.shutdownSignal.aborted) {
        // 再接続待ちの間に積まれた /reconnect は今回の復旧で満たされた。
        options.eventQueue.findSendEvents(
          (event) => event.type === 'operator.reconnect',
        );
      }
      continue;
    }

    const payload: ConductorDispatchPayload = {
      events: batch,
      sourceKey: dispatchResult.sourceKey,
      operatorInputTexts: dispatchResult.operatorInputTexts,
    };
    const lease = lifecycle.beginSend(payload);
    if (!lease) {
      if (reservation) recoveryInbox.release(reservation);
      continue;
    }
    if (dispatchResult.fromHeldEvents) {
      const selectedEvents = new Set(batch);
      dispatchHoldState.heldEvents = dispatchHoldState.heldEvents.filter(
        (event) => !selectedEvents.has(event),
      );
      notifyHeldDispatchProgress({
        dispatchHoldState,
        onDispatchHoldChanged: options.onDispatchHoldChanged,
      });
    } else {
      options.eventQueue.removeEvents(batch);
    }
    if (selected) {
      dispatchBatchState = markContinuationConsumed(dispatchBatchState, selected);
    }

    const autonomousTurnsAfter = autonomousTurnsAfterConductorBatch(
      batch,
      autonomousTurns,
    );
    const { workerDispatches, workerFailures } = countWorkerOutcomesInBatch(batch);
    options.onOperatorDispatched?.(batch);
    options.onConductorInbound?.({
      triggers: batch.filter(isTriggerSessionEvent).length,
      sources: uniqueSources(batch, dispatchResult.sourceKey),
    });
    const eventMessage = formatSessionEventsForConductor(batch);
    const restoreCursorBootstrap = isCursorBootstrapPending();
    const message = restoreCursorBootstrap
      ? `${options.initialPrompt}\n\n## 今回のセッションイベント\n\n${eventMessage}`
      : eventMessage;
    let dispatchHadToolCalls = false;
    const dispatchSend = runEventConductorSend({
      message,
      ...(restoreCursorBootstrap ? { historyInbound: eventMessage } : {}),
      conductorHandle: options.conductorHandle,
      sendReconnect,
      signal: options.shutdownSignal,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      sendCount,
      autonomousTurns: autonomousTurnsAfter,
      dispatchSource: dispatchResult.sourceKey,
      workerOutcomeDispatches: workerDispatches,
      workerOutcomeFailures: workerFailures,
      githubUpdateIds: batch.flatMap((event) =>
        event.type === 'github.update'
          ? event.items.map((item) => item.id)
          : [],
      ),
      resetOutboundDispatchesThisSend: options.resetOutboundDispatchesThisSend,
      getOutboundDispatchesThisSend: options.getOutboundDispatchesThisSend,
      onSendStarted: options.onSendStarted,
      onSendProgress: (info) => {
        dispatchHadToolCalls = true;
        options.onSendProgress?.(info);
      },
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    }).then((result) => {
      if (restoreCursorBootstrap && isIssueDispatchCompleted(result)) {
        markCursorBootstrapCompleted();
      }
      const explicitInterruptQueued =
        result.status === 'cancelled' &&
        options.eventQueue.snapshot().some(
          (event) =>
            event.type === 'operator.message' &&
            event.delivery === 'interrupt',
        );
      settleAttempt({
        lease,
        events: batch,
        sourceKey: dispatchResult.sourceKey,
        sendCount,
        result,
        ...(reservation ? { reservation } : {}),
        toolCallStarted: dispatchHadToolCalls,
        ...(explicitInterruptQueued
          ? { requiresConfirmation: false }
          : {}),
      });
      if (
        options.onDispatchBatchSettled &&
        batch.some((event) => event.type === 'operator.message')
      ) {
        options.onDispatchBatchSettled({ events: batch, result });
      }
      return result;
    });
    inFlightSend = dispatchSend;
    dispatchBatchState = dispatchBatchStateAfterSend(dispatchResult.sourceKey);
  }

  if (inFlightSend && stopReason !== 'interrupted') {
    lastSendResult = await inFlightSend;
  }

  return {
    stopReason,
    sendCount,
    lastSendResult,
    autonomousTurns,
    lastDispatchesThisTurn,
  };
}

function uniqueSources(batch: SessionEvent[], fallback: string): string[] {
  const sources = [...new Set(batch.map((event) => eventSourceKey(event)))];
  return sources.length > 0 ? sources : [fallback];
}

function withAgentAvailabilityCallbacks(
  options: ConductorSendReconnectOptions,
  onAvailabilityChanged: (
    reason: 'auth' | 'transport',
    info: ConductorReconnectCompleteInfo,
  ) => void,
): ConductorSendReconnectOptions {
  return {
    ...options,
    onAuthReconnectComplete: (info: ConductorReconnectCompleteInfo) => {
      onAvailabilityChanged('auth', info);
      (options.onAuthReconnectComplete ?? options.onReconnectComplete)?.(info);
    },
    onTransportReconnectComplete: (
      info: ConductorReconnectCompleteInfo,
    ) => {
      onAvailabilityChanged('transport', info);
      (options.onTransportReconnectComplete ?? options.onReconnectComplete)?.(
        info,
      );
    },
  };
}

function runEventConductorSend(input: {
  message: string;
  historyInbound?: string;
  conductorHandle: ConductorAgentHandle;
  sendReconnect: ConductorSendReconnectOptions;
  signal: AbortSignal;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  sendCount: number;
  autonomousTurns: number;
  dispatchSource?: string;
  githubUpdateIds: string[];
  workerOutcomeDispatches?: number;
  workerOutcomeFailures?: number;
  resetOutboundDispatchesThisSend?: () => void;
  getOutboundDispatchesThisSend?: () => number;
  onSendStarted?: (info: ConductorSendStartedInfo) => void;
  onSendProgress?: (info: ConductorSendProgressInfo) => void;
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const nextSendCount = input.sendCount + 1;

  input.resetOutboundDispatchesThisSend?.();

  input.onSendStarted?.({
    sendCount: nextSendCount,
    dispatchSource: input.dispatchSource,
  });

  return sendConductorWithReconnect(
    input.conductorHandle,
    input.message,
    {
      ...input.sendReconnect,
      signal: input.signal,
      history: {
        sendCount: nextSendCount,
        ...(input.dispatchSource ? { dispatchSource: input.dispatchSource } : {}),
      },
      onToolCallStarted: (info) => {
        input.onSendProgress?.({
          sendCount: nextSendCount,
          runId: info.runId,
          tool: info.tool,
        });
      },
    },
  )
    .catch(() => {
      // Keep sendConductorWithReconnect's public rejection contract. A rejected
      // send has an unknown provider outcome, so this workflow settles it
      // locally without retaining the raw exception or retrying the prompt.
      return { runId: '', status: 'send_rejected' } as ConductorSendResult;
    })
    .then((sendResult) => {
    const completedDuringSend = input.workerDispatches.length - workersBefore;
    const outboundDispatches = input.getOutboundDispatchesThisSend?.() ?? 0;
    const conductorDispatches = Math.max(completedDuringSend, outboundDispatches);
    const conductorFailures = input.workerFailures.length - failuresBefore;

    input.onSendComplete({
      sendCount: nextSendCount,
      runId: sendResult.runId,
      status: sendResult.status,
      inbound: input.message,
      ...(input.historyInbound !== undefined
        ? { historyInbound: input.historyInbound }
        : {}),
      dispatchSource: input.dispatchSource,
      result: sendResult.result,
      error: sendResult.error,
      usage: sendResult.usage,
      modelId: sendResult.modelId,
      workerDispatches: input.workerOutcomeDispatches ?? conductorDispatches,
      workerFailures: input.workerOutcomeFailures ?? conductorFailures,
      conductorDispatchesThisTurn: conductorDispatches + conductorFailures,
      autonomousTurns: input.autonomousTurns,
      githubUpdateIds: input.githubUpdateIds,
    });

    return sendResult;
  });
}

function isIssueDispatchCompleted(result: ConductorSendResult): boolean {
  return (
    result.status === 'finished' ||
    result.status === 'completed' ||
    result.status === 'running'
  );
}

interface DispatchBatchResult {
  events: SessionEvent[];
  sourceKey: string;
  operatorInputTexts: string[];
  selected?: NonNullable<ReturnType<typeof selectDispatchBatch>>;
  reservation?: ConductorRecoveryReservation;
  fromHeldEvents?: boolean;
}

async function waitForDispatchBatch(input: {
  eventQueue: SessionEventQueue;
  dispatchBatchState: DispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
  lifecycle: ConductorDispatchLifecycle<ConductorDispatchPayload>;
  recoveryInbox: ConductorRecoveryInbox;
  operatorCanInspectRecovery: boolean;
  signal: AbortSignal;
  dispatchHoldState: DispatchHoldState;
  onDispatchHoldChanged?: (change: DispatchHoldChange) => void;
  onOperatorQueueChanged?: () => void;
  onRecoveryCapacityBlocked?: () => void;
  isPermissionPending?: (requestId: string) => boolean;
  canDispatchIdleOperatorMessage: () => boolean;
}): Promise<DispatchBatchResult | undefined> {
  let capacityNoticeSent = false;
  for (;;) {
    if (!input.lifecycle.canDispatch) {
      const queuedReconnects = input.eventQueue
        .snapshot()
        .filter((event) => event.type === 'operator.reconnect');
      if (queuedReconnects.length > 0) {
        if (
          input.eventQueue
            .snapshot()
            .some((event) => event.type === 'operator.message')
        ) {
          input.onOperatorQueueChanged?.();
        }
        return {
          events: queuedReconnects,
          sourceKey: 'operator.reconnect',
          operatorInputTexts: [],
        };
      }

      await waitForDispatchChange(input);
      continue;
    }

    if (input.dispatchHoldState.dispatchHold) {
      bufferDispatchHoldEvents({
        state: input.dispatchHoldState,
        eventQueue: input.eventQueue,
        onChanged: input.onDispatchHoldChanged,
      });
    }

    if (input.isPermissionPending) {
      pruneStalePermissionEvents({
        state: input.dispatchHoldState,
        eventQueue: input.eventQueue,
        isPermissionPending: input.isPermissionPending,
        onChanged: input.onDispatchHoldChanged,
      });
    }

    const selected = selectDispatchBatch({
      queue: input.eventQueue.snapshot(),
      state: input.dispatchBatchState,
      autonomousTurns: input.autonomousTurns,
      maxTurns: input.maxTurns,
      allowIdleOperatorMessages: input.canDispatchIdleOperatorMessage(),
    });

    const prepareDispatch = (dispatch: {
      events: SessionEvent[];
      sourceKey: string;
      selected?: NonNullable<ReturnType<typeof selectDispatchBatch>>;
      fromHeldEvents?: boolean;
    }): DispatchBatchResult | undefined => {
      const operatorInputTexts = dispatch.events.flatMap((event) =>
        event.type === 'operator.message'
          ? [event.operatorInput ?? event.text]
          : [],
      );
      const reserved = input.operatorCanInspectRecovery
        ? input.recoveryInbox.reserve(operatorInputTexts)
        : { ok: true as const, reservation: undefined };
      if (!reserved.ok) {
        if (reserved.reason === 'input_too_large') {
          throw new Error(
            'An operator input reached dispatch without passing the recovery admission limit.',
          );
        }
        if (!capacityNoticeSent) {
          capacityNoticeSent = true;
          input.onRecoveryCapacityBlocked?.();
        }
        return undefined;
      }
      return {
        events: dispatch.events,
        sourceKey: dispatch.sourceKey,
        operatorInputTexts,
        ...(dispatch.selected ? { selected: dispatch.selected } : {}),
        ...(reserved.reservation ? { reservation: reserved.reservation } : {}),
        ...(dispatch.fromHeldEvents ? { fromHeldEvents: true } : {}),
      };
    };

    // Operator input, reconnect, and permission decisions retain their
    // immediate priority. Lower-priority events must wait while a released hold
    // contains an eligible permission or worker event.
    if (selected && isImmediateDispatchSource(selected.batch.sourceKey)) {
      const dispatch = prepareDispatch({
        events: selected.batch.events,
        sourceKey: selected.batch.sourceKey,
        selected,
      });
      if (dispatch) return dispatch;
      await waitForDispatchChange(input);
      continue;
    }

    if (
      !input.dispatchHoldState.dispatchHold &&
      input.dispatchHoldState.heldEvents.length > 0
    ) {
      const heldEvents = input.dispatchHoldState.heldEvents;
      const allHeldEventsDispatchable = heldEvents.every((event) =>
        canDispatchConductorSend(event, input.autonomousTurns, input.maxTurns),
      );
      const selectedHeld = allHeldEventsDispatchable
        ? undefined
        : selectDispatchBatch({
            queue: heldEvents,
            state: input.dispatchBatchState,
            autonomousTurns: input.autonomousTurns,
            maxTurns: input.maxTurns,
          });
      const selectedHeldBatch =
        selectedHeld?.batch ??
        (allHeldEventsDispatchable
          ? { events: [...heldEvents], sourceKey: 'dispatch-hold' }
          : undefined);
      if (selectedHeldBatch && selectedHeldBatch.events.length > 0) {
        const dispatch = prepareDispatch({
          events: selectedHeldBatch.events,
          sourceKey: selectedHeldBatch.sourceKey,
          ...(selectedHeld ? { selected: selectedHeld } : {}),
          fromHeldEvents: true,
        });
        if (dispatch) return dispatch;
        await waitForDispatchChange(input);
        continue;
      }
    }

    if (selected && selected.batch.events.length > 0) {
      const dispatch = prepareDispatch({
        events: selected.batch.events,
        sourceKey: selected.batch.sourceKey,
        selected,
      });
      if (dispatch) return dispatch;
      await waitForDispatchChange(input);
      continue;
    }

    await waitForDispatchChange(input);
  }
}

function isImmediateDispatchSource(sourceKey: string): boolean {
  return (
    sourceKey === 'operator' ||
    sourceKey === 'operator.reconnect' ||
    sourceKey === 'permission'
  );
}

function waitForDispatchChange(input: {
  eventQueue: SessionEventQueue;
  lifecycle: ConductorDispatchLifecycle<ConductorDispatchPayload>;
  recoveryInbox: ConductorRecoveryInbox;
  signal: AbortSignal;
  onOperatorQueueChanged?: () => void;
}): Promise<void> {
  if (input.signal.aborted) {
    return Promise.reject(
      new DOMException('Conductor dispatch wait aborted', 'AbortError'),
    );
  }

  return new Promise((resolve, reject) => {
    const subscriptions: Array<() => void> = [];
    const queuedOperatorMessages = input.eventQueue
      .snapshot()
      .filter((event) => event.type === 'operator.message').length;
    const cleanup = () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      input.signal.removeEventListener('abort', onAbort);
    };
    const onChange = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Conductor dispatch wait aborted', 'AbortError'));
    };
    const onQueueChanged = () => {
      const nextOperatorMessageCount = input.eventQueue
        .snapshot()
        .filter((event) => event.type === 'operator.message').length;
      if (nextOperatorMessageCount > queuedOperatorMessages) {
        input.onOperatorQueueChanged?.();
      }
      onChange();
    };
    subscriptions.push(
      input.eventQueue.subscribe(onQueueChanged),
      input.lifecycle.subscribe(onChange),
      input.recoveryInbox.subscribe(onChange),
    );
    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function waitForCursorBootstrapDecision(input: {
  state: CursorBootstrapState;
  lifecycle: ConductorDispatchLifecycle<ConductorDispatchPayload>;
  eventQueue: SessionEventQueue;
  onOperatorQueueChanged?: () => void;
  signal: AbortSignal;
}): Promise<void> {
  while (
    input.state.status === 'unknown' ||
    input.state.status === 'saving'
  ) {
    if (input.signal.aborted) {
      throw new DOMException('Cursor bootstrap decision wait aborted', 'AbortError');
    }

    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      let unsubscribeFromEventQueue = () => {};
      let queuedOperatorMessages = input.eventQueue
        .snapshot()
        .filter((event) => event.type === 'operator.message').length;
      if (queuedOperatorMessages > 0) {
        input.onOperatorQueueChanged?.();
      }
      const cleanup = () => {
        unsubscribe();
        unsubscribeFromEventQueue();
        input.signal.removeEventListener('abort', onAbort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onStatusChanged = () => {
        if (
          input.state.status === 'unknown' ||
          input.state.status === 'saving'
        ) {
          return;
        }
        finish();
      };
      const onQueueChanged = () => {
        const nextOperatorMessageCount = input.eventQueue
          .snapshot()
          .filter((event) => event.type === 'operator.message').length;
        if (nextOperatorMessageCount > queuedOperatorMessages) {
          input.onOperatorQueueChanged?.();
        }
        queuedOperatorMessages = nextOperatorMessageCount;
      };
      const onAbort = () => {
        cleanup();
        reject(
          new DOMException(
            'Cursor bootstrap decision wait aborted',
            'AbortError',
          ),
        );
      };

      unsubscribe = input.lifecycle.subscribe(onStatusChanged);
      unsubscribeFromEventQueue = input.eventQueue.subscribe(onQueueChanged);
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
        onStatusChanged();
      }
    });
  }
}

function canDispatchIdleOperatorMessage(input: {
  eventQueue: SessionEventQueue;
  dispatchHoldState: DispatchHoldState;
  workerSession: WorkerSession;
  dispatchBatchState: DispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
}): boolean {
  if (input.workerSession.runtime.runningCount > 0) {
    return false;
  }
  const heldEvents = input.dispatchHoldState.heldEvents;
  if (
    !input.dispatchHoldState.dispatchHold &&
    heldEvents.length > 0 &&
    (heldEvents.every((event) =>
      canDispatchConductorSend(
        event,
        input.autonomousTurns,
        input.maxTurns,
      ),
    ) ||
      selectDispatchBatch({
        queue: heldEvents,
        state: input.dispatchBatchState,
        autonomousTurns: input.autonomousTurns,
        maxTurns: input.maxTurns,
      }) !== undefined)
  ) {
    return false;
  }
  const nonOperatorTriggers = input.eventQueue.snapshot().filter(
    (event) =>
      event.type !== 'operator.message' &&
      event.type !== 'operator.reconnect',
  );
  return (
    selectDispatchBatch({
      queue: nonOperatorTriggers,
      state: input.dispatchBatchState,
      autonomousTurns: input.autonomousTurns,
      maxTurns: input.maxTurns,
    }) === undefined
  );
}

/** `/reconnect` は conductor へ送らず、直近 send 完了後に agent だけ差し替える。 */
async function runOperatorReconnect(
  options: ConductorSessionDriverOptions,
): Promise<boolean> {
  try {
    await reconnectConductorAgent(options.conductorHandle, {
      conductorAgentFactory: options.sendReconnect.conductorAgentFactory,
      conductorOptions: options.sendReconnect.conductorOptions,
      signal: options.shutdownSignal,
      onReconnectAttempt:
        options.sendReconnect.onTransportReconnectAttempt ??
        options.sendReconnect.onReconnectAttempt,
      onReconnectComplete:
        options.sendReconnect.onTransportReconnectComplete ??
        options.sendReconnect.onReconnectComplete,
    });
    return true;
  } catch {
    // Reconnect failures are observable through the callback above. Keep the
    // session alive so the operator can retry or submit another message.
    return false;
  }
}

function notifyHeldDispatchProgress(input: {
  dispatchHoldState: DispatchHoldState;
  onDispatchHoldChanged?: (change: DispatchHoldChange) => void;
}): void {
  input.onDispatchHoldChanged?.({
    status: 'updated',
    hold: input.dispatchHoldState.dispatchHold,
    heldEventCount: input.dispatchHoldState.heldEvents.length,
  });
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

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ value?: T; aborted: boolean }> {
  if (signal.aborted) {
    return { aborted: true };
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve({ aborted: true });
    };

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve({ value, aborted: false });
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
