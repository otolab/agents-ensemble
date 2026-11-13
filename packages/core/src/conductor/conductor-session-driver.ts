import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ensureMaxTurnsOpenQuestion } from '../escalation/enqueue-max-turns-question.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import type { WorkerSession } from '../runtime/worker-session.js';
import type { ConductorSendResult } from './conductor-agent.js';
import { isPiApiKeyResolutionFailure } from './conductor-auth.js';
import type {
  PiAuthRecoverySnapshotStore,
  PiAuthRecoverySnapshotSummary,
} from './pi-auth-recovery-snapshot-store.js';
import type {
  ConductorAgentHandle,
  ConductorAutomaticRetryInfo,
  ConductorReconnectCompleteInfo,
  ConductorSendReconnectOptions,
} from './conductor-send-reconnect.js';
import {
  reconnectConductorAgent,
  sendConductorWithReconnect,
} from './conductor-send-reconnect.js';
import { formatSessionEventsForConductor } from './session/format-session-event.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import type {
  ConductorRecoveryReportEvent,
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
  /** conductor send 中だけ有効な dispatch 保留状態。SessionResumeStore には保存しない。 */
  dispatchHoldState?: DispatchHoldState;
  /** dispatch 保留の切替・件数変化を TUI/観測へ通知する。 */
  onDispatchHoldChanged?: (change: DispatchHoldChange) => void;
  /** conductor send 開始時に outbound dispatch カウンタをリセットする。 */
  resetOutboundDispatchesThisSend?: () => void;
  /** `prompt_worker` 等の outbound dispatch 件数（ループ停止判定向け）。 */
  getOutboundDispatchesThisSend?: () => number;
  /** Failed dispatch の本文を operator-only の process 内 snapshot に保存する。 */
  piAuthRecoverySnapshotStore?: PiAuthRecoverySnapshotStore;
  /** Snapshot の保存・上限 eviction を本文なしで通知する。 */
  onPiAuthRecoverySnapshotStored?: (input: {
    snapshot: PiAuthRecoverySnapshotSummary;
    evictedRecoveryIds: string[];
  }) => void;
}

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
  let inFlightSend: Promise<ConductorSendResult> | undefined;
  let postLoopWaiting = false;
  const dispatchHoldState =
    options.dispatchHoldState ?? createDispatchHoldState();
  let conductorAvailable = true;
  let pendingAuthRecoveryCandidate: PiAuthRecoveryCandidate | undefined;
  let pendingRecoveryReport: ConductorRecoveryReportEvent | undefined;
  const sendReconnect = withAgentAvailabilityCallbacks(
    options.sendReconnect,
    (available) => {
      conductorAvailable = available;
    },
  );

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
      loopState.lastStatus !== 'cancelled';
    if (holdBlocksStop) {
      postLoopWaiting = false;
      return false;
    }
    if (!shouldStop) {
      postLoopWaiting = false;
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

  if (!options.skipInitialSend) {
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
      onSendProgress: options.onSendProgress,
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    });
  }

  while (true) {
    if (options.shutdownSignal.aborted) {
      stopReason = 'interrupted';
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
        (!idleOperatorMessageReady || options.stopOnUnansweredInput === true)
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
        signal: options.shutdownSignal,
        dispatchHoldState,
        onDispatchHoldChanged: options.onDispatchHoldChanged,
        onOperatorQueueChanged: options.onOperatorQueueChanged,
        isPermissionPending: options.isPermissionPending,
        isConductorAvailable: () => conductorAvailable,
        hasPendingRecoveryReport: () => pendingRecoveryReport !== undefined,
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
      stopReason = 'interrupted';
      break;
    }

    const { events: selectedBatch, selected } = dispatchResult;
    postLoopWaiting = false;
    if (selected) {
      dispatchBatchState = markContinuationConsumed(dispatchBatchState, selected);
    }

    if (dispatchResult.sourceKey === 'operator.reconnect') {
      dispatchBatchState = dispatchBatchStateAfterSend(dispatchResult.sourceKey);
      const reconnected = await runOperatorReconnect(options);
      conductorAvailable = reconnected;
      if (reconnected && !options.shutdownSignal.aborted) {
        // 再接続の await 中に届いた reconnect は今回の成功で満たされた。
        // 新しい handle を重ねて close / resume しないよう、ここでまとめて消費する。
        options.eventQueue.findSendEvents(
          (event) => event.type === 'operator.reconnect',
        );
        if (pendingAuthRecoveryCandidate) {
          pendingRecoveryReport = {
            type: 'conductor.recovery.report',
            ...pendingAuthRecoveryCandidate,
            reconnect: { kind: 'manual', succeeded: true },
          };
          pendingAuthRecoveryCandidate = undefined;
        }
      }
      continue;
    }

    const recoveryReport = pendingRecoveryReport;
    const batch = recoveryReport
      ? [recoveryReport, ...selectedBatch]
      : selectedBatch;
    const originalEvents = batch.filter(
      (event) => event.type !== 'conductor.recovery.report',
    );
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
    // 通常 send を開始したら未報告 candidate は失効する。
    // 準備済み report はこの send に一度だけ加え、開始時に消費して replay しない。
    const message = formatSessionEventsForConductor(batch);
    const recoverySnapshotContent = recoveryReport
      ? formatSessionEventsForConductor(originalEvents)
      : message;
    pendingRecoveryReport = undefined;
    pendingAuthRecoveryCandidate = undefined;
    let dispatchHadToolCalls = false;
    let automaticRetryAttempts: 0 | 1 = 0;
    const dispatchSend = runEventConductorSend({
      message,
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
      onAutomaticRetryAttempt: ({ attempt }) => {
        automaticRetryAttempts = attempt;
      },
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    }).then((result) => {
      if (isPiApiKeyResolutionFailure(result) && originalEvents.length > 0) {
        // Pi は1回の send で複数回 auth を解決するため、後続の失敗から
        // 先行 tool round に副作用がなかったとは判断できない。
        // event は再送せず、report 用 candidate と operator-only snapshot を別々に保持する。
        pendingAuthRecoveryCandidate = createPiAuthRecoveryCandidate({
          events: originalEvents,
          sendCount,
          runId: result.runId,
          sourceKey: dispatchResult.sourceKey,
          automaticRetryAttempts,
          toolCallStarted: dispatchHadToolCalls,
        });
        const storedSnapshot = options.piAuthRecoverySnapshotStore?.add(
          pendingAuthRecoveryCandidate,
          recoverySnapshotContent,
        );
        if (storedSnapshot) {
          options.onPiAuthRecoverySnapshotStored?.(storedSnapshot);
        }
      }
      return result;
    });
    if (
      options.onDispatchBatchSettled &&
      batch.some((event) => event.type === 'operator.message')
    ) {
      inFlightSend = dispatchSend.then(
        (result) => {
          options.onDispatchBatchSettled?.({ events: batch, result });
          return result;
        },
        (error: unknown) => {
          options.onDispatchBatchSettled?.({ events: batch, error });
          throw error;
        },
      );
    } else {
      inFlightSend = dispatchSend;
    }
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

type PiAuthRecoveryCandidate = Pick<
  ConductorRecoveryReportEvent,
  'recoveryId' | 'failedDispatch' | 'failure'
>;

const MAX_RECOVERY_EVENT_REFERENCES = 20;

function createPiAuthRecoveryCandidate(input: {
  events: SessionEvent[];
  sendCount: number;
  runId: string;
  sourceKey: string;
  automaticRetryAttempts: 0 | 1;
  toolCallStarted: boolean;
}): PiAuthRecoveryCandidate {
  const eventReferences = input.events.map((event, index) => ({
    eventIndex: index + 1,
    ...recoveryEventReference(event),
  }));
  return {
    recoveryId: `pi-auth-recovery-${input.sendCount}`,
    failedDispatch: {
      sendCount: input.sendCount,
      runId: input.runId,
      sourceKey: input.sourceKey,
      eventTypes: [...new Set(input.events.map((event) => event.type))],
      eventCount: input.events.length,
      eventReferences: eventReferences.slice(0, MAX_RECOVERY_EVENT_REFERENCES),
      eventReferencesTruncated:
        eventReferences.length > MAX_RECOVERY_EVENT_REFERENCES,
    },
    failure: {
      kind: 'pi_api_key_resolution',
      automaticRetryAttempts: input.automaticRetryAttempts,
      toolCallStarted: input.toolCallStarted,
    },
  };
}

function recoveryEventReference(
  event: SessionEvent,
): { type: string; reference?: string } {
  switch (event.type) {
    case 'operator.message':
      return {
        type: event.type,
        reference: `delivery:${event.delivery ?? 'next'}`,
      };
    case 'operator.reconnect':
      return { type: event.type };
    case 'worker.completed':
      return {
        type: event.type,
        reference: `worker:${event.result.name}:${event.result.kind}`,
      };
    case 'worker.failed':
      return {
        type: event.type,
        reference: `worker:${event.failure.name}:${event.failure.kind}`,
      };
    case 'worker.session.recovered':
      return {
        type: event.type,
        reference: `worker:${event.name}:${event.kind}`,
      };
    case 'permission.pending':
      return {
        type: event.type,
        reference: `permission:${event.permission.id}`,
      };
    case 'permission.stall':
      return {
        type: event.type,
        reference: summarizeRecoveryReferences(
          'permissions',
          event.pendingPermissionIds,
        ),
      };
    case 'harness.connectivity.recovered':
      return {
        type: event.type,
        reference: `${event.source}:${event.suppressedErrorCount}`,
      };
    case 'conductor.recovery.report':
      return {
        type: event.type,
        reference: `recovery:${event.recoveryId}`,
      };
    case 'github.update':
      return {
        type: event.type,
        reference: summarizeRecoveryReferences(
          'items',
          event.items.map((item) => item.id),
        ),
      };
    default: {
      const _exhaustive: never = event;
      return { type: String(_exhaustive) };
    }
  }
}

function summarizeRecoveryReferences(prefix: string, values: string[]): string {
  const sampleCount = 5;
  const sample = values.slice(0, sampleCount).join(',');
  const remaining = values.length - sampleCount;
  return `${prefix}:${sample}${remaining > 0 ? `,+${remaining} more` : ''}`;
}

function withAgentAvailabilityCallbacks(
  options: ConductorSendReconnectOptions,
  onAvailabilityChanged: (available: boolean) => void,
): ConductorSendReconnectOptions {
  return {
    ...options,
    onAuthReconnectComplete: (info: ConductorReconnectCompleteInfo) => {
      onAvailabilityChanged(info.success);
      (options.onAuthReconnectComplete ?? options.onReconnectComplete)?.(info);
    },
    onTransportReconnectComplete: (
      info: ConductorReconnectCompleteInfo,
    ) => {
      onAvailabilityChanged(info.success);
      (options.onTransportReconnectComplete ?? options.onReconnectComplete)?.(
        info,
      );
    },
  };
}

function runEventConductorSend(input: {
  message: string;
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
  onAutomaticRetryAttempt?: (info: ConductorAutomaticRetryInfo) => void;
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
      onAutomaticRetry: (info) => {
        input.onAutomaticRetryAttempt?.(info);
        input.sendReconnect.onAutomaticRetry?.(info);
      },
    },
  ).then((sendResult) => {
    const completedDuringSend = input.workerDispatches.length - workersBefore;
    const outboundDispatches = input.getOutboundDispatchesThisSend?.() ?? 0;
    const conductorDispatches = Math.max(completedDuringSend, outboundDispatches);
    const conductorFailures = input.workerFailures.length - failuresBefore;

    input.onSendComplete({
      sendCount: nextSendCount,
      runId: sendResult.runId,
      status: sendResult.status,
      inbound: input.message,
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

interface DispatchBatchResult {
  events: SessionEvent[];
  sourceKey: string;
  selected?: NonNullable<ReturnType<typeof selectDispatchBatch>>;
}

async function waitForDispatchBatch(input: {
  eventQueue: SessionEventQueue;
  dispatchBatchState: DispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
  signal?: AbortSignal;
  dispatchHoldState: DispatchHoldState;
  onDispatchHoldChanged?: (change: DispatchHoldChange) => void;
  onOperatorQueueChanged?: () => void;
  isPermissionPending?: (requestId: string) => boolean;
  isConductorAvailable: () => boolean;
  hasPendingRecoveryReport: () => boolean;
  canDispatchIdleOperatorMessage: () => boolean;
}): Promise<DispatchBatchResult | undefined> {
  for (;;) {
    if (!input.isConductorAvailable()) {
      const queuedReconnects = input.eventQueue.findSendEvents(
        (event) => event.type === 'operator.reconnect',
      );
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
        };
      }

      const reconnect = await input.eventQueue.waitForMatchingEvent(
        (event) => event.type === 'operator.reconnect',
        input.signal,
      );
      const reconnects = [
        reconnect,
        ...input.eventQueue.findSendEvents(
          (event) => event.type === 'operator.reconnect',
        ),
      ];
      if (input.eventQueue.snapshot().some((event) => event.type === 'operator.message')) {
        input.onOperatorQueueChanged?.();
      }
      return {
        events: reconnects,
        sourceKey: 'operator.reconnect',
      };
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

    // operator.message は hold 中も通す。permission.stall も hold 対象外の
    // 低優先度回復通知として queue に残る。release 後は held buffer の
    // permission.pending を worker より先に選び、max-turns 到達後も dispatch する。
    if (selected && isImmediateDispatchSource(selected.batch.sourceKey)) {
      input.eventQueue.replaceQueue(selected.remainingQueue);
      return {
        events: selected.batch.events,
        sourceKey: selected.batch.sourceKey,
        selected,
      };
    }

    if (
      !input.dispatchHoldState.dispatchHold &&
      input.dispatchHoldState.heldEvents.length > 0
    ) {
      const heldEvents = input.dispatchHoldState.heldEvents;
      if (
        heldEvents.every((event) =>
          canDispatchConductorSend(event, input.autonomousTurns, input.maxTurns),
        )
      ) {
        const events = heldEvents.splice(0);
        notifyHeldDispatchProgress(input);
        return {
          events,
          sourceKey: 'dispatch-hold',
        };
      }

      // max-turns blocks worker/GitHub events, but held permission.pending events
      // remain dispatchable. Reuse the normal selector to preserve their priority.
      const selectedHeld = selectDispatchBatch({
        queue: heldEvents,
        state: input.dispatchBatchState,
        autonomousTurns: input.autonomousTurns,
        maxTurns: input.maxTurns,
      });
      if (selectedHeld) {
        input.dispatchHoldState.heldEvents = selectedHeld.remainingQueue;
        notifyHeldDispatchProgress(input);
        return {
          events: selectedHeld.batch.events,
          sourceKey: selectedHeld.batch.sourceKey,
          selected: selectedHeld,
        };
      }
    }

    if (selected) {
      input.eventQueue.replaceQueue(selected.remainingQueue);
      return {
        events: selected.batch.events,
        sourceKey: selected.batch.sourceKey,
        selected,
      };
    }

    const hasDeferredIdleOperatorMessage =
      input.eventQueue
        .snapshot()
        .some(
          (event) =>
            event.type === 'operator.message' && event.delivery === 'idle',
        ) && !input.canDispatchIdleOperatorMessage();
    // report 単独 send で dispatch hold を迂回しない。hold 解除後は held event が
    // maxTurns で保留中でも、この有限の通知は送れる。
    if (
      input.hasPendingRecoveryReport() &&
      !input.dispatchHoldState.dispatchHold &&
      !hasDeferredIdleOperatorMessage
    ) {
      return {
        events: [],
        sourceKey: 'conductor.recovery.report',
      };
    }

    const hadQueued = input.eventQueue.size > 0;
    const incoming = await input.eventQueue.waitForEvent(input.signal, {
      onlyNew: hadQueued,
    });
    // waiter 経由のイベントは queue に載らない。到着順を保つため先頭へ戻す。
    input.eventQueue.prependSilent(incoming);
    if (incoming.type === 'operator.message') input.onOperatorQueueChanged?.();
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

function isImmediateDispatchSource(sourceKey: string): boolean {
  return (
    sourceKey === 'operator' ||
    sourceKey === 'operator.reconnect' ||
    sourceKey === 'permission'
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
