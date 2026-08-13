import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ensureMaxTurnsOpenQuestion } from '../escalation/enqueue-max-turns-question.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { OpenQuestionRegistry } from '../escalation/open-question.js';
import { fetchIssueContext } from '../github/issue-context.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { ResolvedProfile } from '../profile/types.js';
import { resolveAgentPromptModule } from '../profile/types.js';
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

export interface ConductorSendStartedInfo {
  /** これから実行する send の通し番号（1 始まり）。 */
  sendCount: number;
  /** dispatch 束の source key（`operator` / `permission` / `worker:*` / `initial`）。 */
  dispatchSource?: string;
}

export interface ConductorSendProgressInfo {
  sendCount: number;
  runId: string;
  tool: string;
}

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
  profile: ResolvedProfile;
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
  onSendStarted?: (info: ConductorSendStartedInfo) => void;
  onSendProgress?: (info: ConductorSendProgressInfo) => void;
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
  let inFlightSend: Promise<ConductorSendResult> | undefined;

  if (!options.skipInitialSend) {
    lastSendResult = await runEventConductorSend({
      message: await buildInitialConductorMessage({
        issueUrl: options.issueUrl,
        profile: options.profile,
      }),
      conductorHandle: options.conductorHandle,
      sendReconnect: options.sendReconnect,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      sendCount: 0,
      autonomousTurns: 1,
      dispatchSource: 'initial',
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
      lastSendResult = await inFlightSend;
      inFlightSend = undefined;

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
      continue;
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
    inFlightSend = runEventConductorSend({
      message: formatSessionEventsForConductor(batch),
      conductorHandle: options.conductorHandle,
      sendReconnect: options.sendReconnect,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      sendCount,
      autonomousTurns: autonomousTurnsAfter,
      dispatchSource: selected.batch.sourceKey,
      workerOutcomeDispatches: workerDispatches,
      workerOutcomeFailures: workerFailures,
      onSendStarted: options.onSendStarted,
      onSendProgress: options.onSendProgress,
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.conductorDispatchesThisTurn;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    });
    dispatchBatchState = dispatchBatchStateAfterSend(selected.batch.sourceKey);
  }

  if (inFlightSend) {
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

async function buildInitialConductorMessage(input: {
  issueUrl: string;
  profile: ResolvedProfile;
}): Promise<string> {
  const issueContext = await fetchIssueContext(input.issueUrl);
  return compileConductorSystemPrompt({
    issueUrl: input.issueUrl,
    profile: input.profile,
    agentModule: resolveAgentPromptModule('conductor', input.profile.agents),
    issueContext,
  });
}

function runEventConductorSend(input: {
  message: string;
  conductorHandle: ConductorAgentHandle;
  sendReconnect: ConductorSendReconnectOptions;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  sendCount: number;
  autonomousTurns: number;
  dispatchSource?: string;
  workerOutcomeDispatches?: number;
  workerOutcomeFailures?: number;
  onSendStarted?: (info: ConductorSendStartedInfo) => void;
  onSendProgress?: (info: ConductorSendProgressInfo) => void;
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const nextSendCount = input.sendCount + 1;

  input.onSendStarted?.({
    sendCount: nextSendCount,
    dispatchSource: input.dispatchSource,
  });

  return sendConductorWithReconnect(
    input.conductorHandle,
    input.message,
    {
      ...input.sendReconnect,
      onToolCallStarted: (info) => {
        input.onSendProgress?.({
          sendCount: nextSendCount,
          runId: info.runId,
          tool: info.tool,
        });
      },
    },
  ).then((sendResult) => {
    const conductorDispatches = input.workerDispatches.length - workersBefore;
    const conductorFailures = input.workerFailures.length - failuresBefore;

    input.onSendComplete({
      sendCount: nextSendCount,
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
  });
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
