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
import type { ConductorAgent, ConductorSendResult } from './conductor-agent.js';
import { formatSessionEventForConductor } from './session/format-session-event.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import type { SessionEvent } from './session/session-event.js';
import { isConductorSendEvent } from './session/session-event.js';
import {
  autonomousTurnsAfterConductorSend,
  buildIssueLoopStopInput,
  canDispatchConductorSend,
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
  workerDispatches: number;
  workerFailures: number;
  autonomousTurns: number;
}

export interface ConductorSessionDriverOptions {
  issueUrl: string;
  profile: Profile;
  conductor: ConductorAgent;
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
}

export interface ConductorSessionDriverResult {
  stopReason: IssueLoopStopReason;
  sendCount: number;
  lastSendResult: ConductorSendResult;
  autonomousTurns: number;
}

/**
 * ConductorSession のイベント消費ループ（SessionDriver）。
 * dispatch / stop 判定は SessionPolicy を参照する。
 */
export async function runConductorSessionDriver(
  options: ConductorSessionDriverOptions,
): Promise<ConductorSessionDriverResult> {
  let sendCount = 0;
  let lastDispatchesThisTurn = 0;
  let autonomousTurns = 0;
  let stopReason: IssueLoopStopReason = 'completed';
  let lastSendResult: ConductorSendResult = {
    runId: '',
    status: 'finished',
  };

  lastSendResult = await runInitialConductorSend({
    issueUrl: options.issueUrl,
    profile: options.profile,
    conductor: options.conductor,
    workerDispatches: options.workerDispatches,
    workerFailures: options.workerFailures,
    onSendComplete: (info) => {
      sendCount = info.sendCount;
      lastDispatchesThisTurn = info.workerDispatches + info.workerFailures;
      autonomousTurns = info.autonomousTurns;
      options.onSendComplete(info);
    },
  });

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

    let event: SessionEvent | undefined;
    try {
      event = await options.eventQueue.waitForSendEvent({
        signal: options.shutdownSignal,
        accept: (candidate) =>
          canDispatchConductorSend(
            candidate,
            autonomousTurns,
            options.maxTurns,
          ),
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

    const autonomousTurnsAfter = autonomousTurnsAfterConductorSend(
      event,
      autonomousTurns,
    );
    lastSendResult = await runEventConductorSend({
      message: formatSessionEventForConductor(event),
      conductor: options.conductor,
      workerDispatches: options.workerDispatches,
      workerFailures: options.workerFailures,
      sendCount,
      autonomousTurns: autonomousTurnsAfter,
      onSendComplete: (info) => {
        sendCount = info.sendCount;
        lastDispatchesThisTurn = info.workerDispatches + info.workerFailures;
        autonomousTurns = info.autonomousTurns;
        options.onSendComplete(info);
      },
    });

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
  };
}

async function runInitialConductorSend(input: {
  issueUrl: string;
  profile: Profile;
  conductor: ConductorAgent;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
}): Promise<ConductorSendResult> {
  await fetchIssueContext(input.issueUrl);
  const message = compileConductorSystemPrompt({
    issueUrl: input.issueUrl,
    profile: input.profile,
    roleBootstrap: resolveAgentSystemPrompt('conductor', input.profile.agents),
  });

  return runEventConductorSend({
    message,
    conductor: input.conductor,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    sendCount: 0,
    autonomousTurns: 1,
    onSendComplete: input.onSendComplete,
  });
}

async function runEventConductorSend(input: {
  message: string;
  conductor: ConductorAgent;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  sendCount: number;
  autonomousTurns: number;
  onSendComplete: (info: ConductorSendCompleteInfo) => void;
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
    autonomousTurns: input.autonomousTurns,
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
