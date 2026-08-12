import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ensureMaxTurnsOpenQuestion } from '../escalation/enqueue-max-turns-question.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import { fetchIssueContext } from '../github/issue-context.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { Profile } from '../profile/types.js';
import { resolveAgentSystemPrompt } from '../profile/types.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import type { WorkerSession } from '../runtime/worker-session.js';
import { compileConductorSystemPrompt } from '../prompt/compile-system-prompt.js';
import type { ConductorSendResult } from './conductor-agent.js';
import type { ConductorAgentHandle, ConductorSendReconnectOptions } from './conductor-send-reconnect.js';
import { sendConductorWithReconnect } from './conductor-send-reconnect.js';
import { formatSessionEventsForConductor } from './session/format-session-event.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import type { SessionEvent } from './session/session-event.js';
import {
  countWorkerOutcomesInBatch,
  dispatchBatchStateAfterSend,
  markContinuationConsumed,
  selectDispatchBatch,
  type DispatchBatchState,
} from './session/select-dispatch-batch.js';
import {
  autonomousTurnsAfterConductorBatch,
  buildIssueLoopStopInput,
  isMaxTurnsLimited,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
  type IssueLoopStopReason,
} from './session-policy.js';

export interface ConductorSendCompleteInfo {
  sendCount: number;
  runId: string;
  status: ConductorSendResult['status'];
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
  profile: Profile;
  conductorHandle: ConductorAgentHandle;
  sendReconnect: ConductorSendReconnectOptions;
  eventQueue: SessionEventQueue;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  openQuestions: OpenQuestionRegistry;
  shutdownSignal: AbortSignal;
  maxTurns: number;
  continueOnConductorError: boolean;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
  onOpenQuestionEnqueued?: (question: OpenQuestion) => void;
  /** post-loop 再開時は初回 `agent.send`（system + ブリーフィング）を省略する。 */
  skipInitialSend?: boolean;
  /** `skipInitialSend` 時に引き継ぐ Driver 状態。 */
  resumeState?: Pick<
    ConductorSessionDriverResult,
    'sendCount' | 'autonomousTurns' | 'lastSendResult'
  > & { lastDispatchesThisTurn: number };
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
  let sendCount = options.resumeState?.sendCount ?? 0;
  let lastDispatchesThisTurn = options.resumeState?.lastDispatchesThisTurn ?? 0;
  let autonomousTurns = options.resumeState?.autonomousTurns ?? 0;
  let dispatchBatchState: DispatchBatchState = {};
  let stopReason: IssueLoopStopReason = 'completed';
  let lastSendResult: ConductorSendResult = options.resumeState?.lastSendResult ?? {
    runId: '',
    status: 'finished',
  };

  if (!options.skipInitialSend) {
    lastSendResult = await runInitialConductorSend({
      issueUrl: options.issueUrl,
      profile: options.profile,
      conductorHandle: options.conductorHandle,
      sendReconnect: options.sendReconnect,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    });
  }

  while (true) {
    if (
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

    if (
      options.eventQueue.isEmpty() &&
      options.workerSession.runtime.runningCount === 0
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
      });
      stopReason = resolveIssueLoopStopReason(loopState);
      if (shouldStopIssueLoop(loopState)) {
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

    const { events: batch, selected } = dispatchResult;
    dispatchBatchState = markContinuationConsumed(dispatchBatchState, selected);

    const autonomousTurnsAfter = autonomousTurnsAfterConductorBatch(
      batch,
      autonomousTurns,
    );
    const { workerDispatches, workerFailures } = countWorkerOutcomesInBatch(batch);
    lastSendResult = await runEventConductorSend({
      message: formatSessionEventsForConductor(batch),
      conductorHandle: options.conductorHandle,
      sendReconnect: options.sendReconnect,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      sendCount,
      autonomousTurns: autonomousTurnsAfter,
      workerOutcomeDispatches: workerDispatches,
      workerOutcomeFailures: workerFailures,
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    });
    dispatchBatchState = dispatchBatchStateAfterSend(selected.batch.sourceKey);

    const loopState = buildIssueLoopStopInput({
      autonomousTurns,
      maxTurns: options.maxTurns,
      lastSendResult,
      dispatchesThisTurn: lastDispatchesThisTurn,
      workerSession: options.workerSession,
      permissionPipeline: options.permissionPipeline,
      openQuestions: options.openQuestions,
      continueOnConductorError: options.continueOnConductorError,
    });
    stopReason = resolveIssueLoopStopReason(loopState);

    if (shouldStopIssueLoop(loopState)) {
      break;
    }
  }

  return {
    stopReason,
    sendCount,
    lastSendResult,
    autonomousTurns,
    lastDispatchesThisTurn,
  };
}

async function runInitialConductorSend(input: {
  issueUrl: string;
  profile: Profile;
  conductorHandle: ConductorAgentHandle;
  sendReconnect: ConductorSendReconnectOptions;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
}): Promise<ConductorSendResult> {
  const issueContext = await fetchIssueContext(input.issueUrl);
  const message = compileConductorSystemPrompt({
    issueUrl: input.issueUrl,
    profile: input.profile,
    roleBootstrap: resolveAgentSystemPrompt('conductor', input.profile.agents),
    issueContext,
  });

  return runEventConductorSend({
    message,
    conductorHandle: input.conductorHandle,
    sendReconnect: input.sendReconnect,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    sendCount: 0,
    autonomousTurns: 1,
    onSendComplete: input.onSendComplete,
  });
}

async function runEventConductorSend(input: {
  message: string;
  conductorHandle: ConductorAgentHandle;
  sendReconnect: ConductorSendReconnectOptions;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  sendCount: number;
  autonomousTurns: number;
  workerOutcomeDispatches?: number;
  workerOutcomeFailures?: number;
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;

  const sendResult = await sendConductorWithReconnect(
    input.conductorHandle,
    input.message,
    input.sendReconnect,
  );
  const sendCount = input.sendCount + 1;
  const conductorDispatches = input.workerDispatches.length - workersBefore;
  const conductorFailures = input.workerFailures.length - failuresBefore;

  input.onSendComplete({
    sendCount,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    usage: sendResult.usage,
    modelId: sendResult.modelId,
    workerDispatches: input.workerOutcomeDispatches ?? conductorDispatches,
    workerFailures: input.workerOutcomeFailures ?? conductorFailures,
    conductorDispatchesThisTurn: conductorDispatches + conductorFailures,
    autonomousTurns: input.autonomousTurns,
  });

  return sendResult;
}

interface DispatchBatchResult {
  events: SessionEvent[];
  sourceKey: string;
  selected: NonNullable<ReturnType<typeof selectDispatchBatch>>;
}

async function waitForDispatchBatch(input: {
  eventQueue: SessionEventQueue;
  dispatchBatchState: DispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
  signal?: AbortSignal;
}): Promise<DispatchBatchResult | undefined> {
  for (;;) {
    const selected = selectDispatchBatch({
      queue: input.eventQueue.snapshot(),
      state: input.dispatchBatchState,
      autonomousTurns: input.autonomousTurns,
      maxTurns: input.maxTurns,
    });
    if (selected) {
      input.eventQueue.replaceQueue(selected.remainingQueue);
      return {
        events: selected.batch.events,
        sourceKey: selected.batch.sourceKey,
        selected,
      };
    }

    const hadQueued = input.eventQueue.size > 0;
    const incoming = await input.eventQueue.waitForEvent(input.signal, {
      onlyNew: hadQueued,
    });
    // waiter 経由のイベントは queue に載らない。到着順を保つため先頭へ戻す。
    input.eventQueue.prependSilent(incoming);
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
