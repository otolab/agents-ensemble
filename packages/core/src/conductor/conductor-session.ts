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
import { SessionDialogueLog } from '../escalation/dialogue-log.js';
import type { DialogueEntry } from '../escalation/dialogue-log.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import { fetchIssueContext } from '../github/issue-context.js';
import type { PermissionPolicyRules } from '../permission/permission-policy.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { createResolvePermissionTool } from '../permission/resolve-permission-tool.js';
import type { Profile } from '../profile/types.js';
import { profileWorkersToSessionSpecs } from '../profile/types.js';
import { WorkerSession } from '../runtime/worker-session.js';
import type { WorkerDispatchFn } from '../runtime/worker-runtime.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import { compileConductorInitialMessage } from './prompt/compile-conductor-prompt.js';
import { mergeConductorMaterials } from './prompt/materials.js';
import type { ConductorMaterial } from './prompt/types.js';
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

export interface OperatorInputContext {
  /** これから実行する conductor ターン番号（1 始まり）。 */
  conductorTurn: number;
  autonomousTurns: number;
  maxTurns: number;
  openQuestions: OpenQuestion[];
}

export interface RunConductorSessionOptions {
  issueUrl: string;
  repoRoot: string;
  conductorCwd?: string;
  briefing?: string;
  materials?: ConductorMaterial[];
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
  dispatchWorker?: WorkerDispatchFn;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
  onTurnComplete?: (turn: ConductorSessionTurn) => void;
  onEscalated?: (record: EscalationRecord) => void;
  onOpenQuestionEnqueued?: (question: OpenQuestion) => void;
}

export interface ConductorSessionTurn {
  turn: number;
  runId: string;
  status: ConductorSendResult['status'];
  result?: string;
  error?: ConductorSendResult['error'];
  /** worker 完了数（このターン内）。 */
  workerDispatches: number;
  /** worker 失敗数（このターン内）。 */
  workerFailures: number;
  escalations: number;
}

export interface ConductorSessionResult {
  agentId: string;
  issueUrl: string;
  repoRoot: string;
  turnCount: number;
  stopReason: IssueLoopStopReason;
  turns: ConductorSessionTurn[];
  lastRunStatus: string;
  lastResult?: string;
  lastError?: { message: string; code?: string };
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  openQuestions: OpenQuestion[];
  dialogueLog: DialogueEntry[];
}

export async function runConductorSession(
  options: RunConductorSessionOptions,
): Promise<ConductorSessionResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_ISSUE_TURNS;
  const workerDispatches: WorkerDispatchResult[] = [];
  const workerFailures: WorkerFailureRecord[] = [];
  const escalations: EscalationRecord[] = [];
  const turns: ConductorSessionTurn[] = [];
  const openQuestions = new OpenQuestionRegistry();
  const dialogueLog = new SessionDialogueLog();
  const eventQueue = new SessionEventQueue();

  const permissionPipeline =
    options.permissionPipeline ??
    new PermissionPipeline({ policy: options.permissionPolicy });

  const workerSession = new WorkerSession({
    issueUrl: options.issueUrl,
    repoRoot: options.repoRoot,
    workers: profileWorkersToSessionSpecs(options.profile),
    permissionPipeline,
    ...(options.dispatchWorker ? { dispatchWorker: options.dispatchWorker } : {}),
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
      eventQueue.enqueue({ type: 'worker.completed', result });
      options.onWorkerDispatched?.(result);
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
  };

  const askHumanTools = createAskHumanTool({
    registry: openQuestions,
    dialogueLog,
    onEnqueued: (question) => {
      options.onOpenQuestionEnqueued?.(question);
    },
  });

  const answerOpenQuestionTools = createAnswerOpenQuestionTool({
    registry: openQuestions,
    dialogueLog,
    onAnswered: recordAnsweredQuestion,
  });

  const openQuestionListTools = createOpenQuestionListTools({
    registry: openQuestions,
  });

  const resolvePermissionTools = createResolvePermissionTool({
    pipeline: permissionPipeline,
    inbox: workerSession.inbox,
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
    },
  };

  const conductor = options.resumeAgentId
    ? await ConductorAgent.resume(options.resumeAgentId, conductorOptions)
    : await ConductorAgent.create(conductorOptions);

  let lastSendResult: ConductorSendResult = {
    runId: '',
    status: 'finished',
  };
  let stopReason: IssueLoopStopReason = 'completed';

  try {
    let autonomousTurns = 0;

    lastSendResult = await runInitialConductorSend({
      options,
      conductor,
      workerSession,
      permissionPipeline,
      workerDispatches,
      workerFailures,
      escalations,
      turns,
      autonomousTurns,
      maxTurns,
    });
    autonomousTurns++;

    while (true) {
      if (openQuestions.openCount > 0) {
        const operatorPhase = await collectOperatorInput({
          conductorTurn: turns.length + 1,
          autonomousTurns,
          maxTurns,
          options,
          openQuestions,
          dialogueLog,
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
        ensureMaxTurnsOpenQuestion(openQuestions, dialogueLog, {
          issueUrl: options.issueUrl,
          autonomousTurns,
          maxTurns,
          turnCount: turns.length,
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
          conductorTurn: turns.length + 1,
          autonomousTurns,
          maxTurns,
          options,
          openQuestions,
          dialogueLog,
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
          event = await eventQueue.waitForEvent();
        } else {
          const sessionTurn = turns[turns.length - 1]!;
          const loopState = buildLoopState({
            autonomousTurns,
            maxTurns,
            lastSendResult,
            sessionTurn,
            workerSession,
            permissionPipeline,
            openQuestions,
          });
          stopReason = resolveIssueLoopStopReason(loopState);
          if (shouldStopIssueLoop(loopState)) {
            break;
          }
          // worker / permission イベントの到着を待つ（空キューでの busy-spin を避ける）
          event = await eventQueue.waitForEvent();
        }
      } else {
        event = eventQueue.dequeue();
      }

      if (!event || !isConductorSendEvent(event)) {
        continue;
      }

      lastSendResult = await runEventConductorSend({
        message: formatSessionEventForConductor(event),
        conductorTurn: turns.length + 1,
        conductor,
        workerDispatches,
        workerFailures,
        escalations,
        turns,
        options,
      });
      autonomousTurns++;

      const sessionTurn = turns[turns.length - 1]!;
      const loopState = buildLoopState({
        autonomousTurns,
        maxTurns,
        lastSendResult,
        sessionTurn,
        workerSession,
        permissionPipeline,
        openQuestions,
      });
      stopReason = resolveIssueLoopStopReason(loopState);

      if (shouldStopIssueLoop(loopState)) {
        break;
      }
    }

    return buildResult();

    function buildResult(): ConductorSessionResult {
      return {
        agentId: conductor.agentId,
        issueUrl: options.issueUrl,
        repoRoot: options.repoRoot,
        turnCount: turns.length,
        stopReason,
        turns,
        lastRunStatus: lastSendResult.status,
        lastResult: lastSendResult.result,
        lastError: lastSendResult.error,
        workerDispatches,
        workerFailures,
        escalations,
        openQuestions: openQuestions.list(),
        dialogueLog: dialogueLog.list(),
      };
    }
  } finally {
    rejectAllPendingPermissions(permissionPipeline, workerSession.inbox);
    await workerSession.stop();
    await conductor.close();
  }
}

function buildLoopState(input: {
  autonomousTurns: number;
  maxTurns: number;
  lastSendResult: ConductorSendResult;
  sessionTurn: ConductorSessionTurn;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  openQuestions: OpenQuestionRegistry;
}) {
  return {
    autonomousTurns: input.autonomousTurns,
    maxTurns: input.maxTurns,
    lastStatus: input.lastSendResult.status,
    dispatchesThisTurn:
      input.sessionTurn.workerDispatches + input.sessionTurn.workerFailures,
    runningWorkers: input.workerSession.runtime.runningCount,
    pendingPermissions: input.permissionPipeline.pending.size,
    openQuestions: input.openQuestions.openCount,
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
  dialogueLog: SessionDialogueLog;
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

  input.dialogueLog.appendOperatorMessage(
    input.conductorTurn,
    operatorMessage,
  );
  const applied = applyOperatorMessage(
    input.openQuestions,
    input.dialogueLog,
    operatorMessage,
  );
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
  conductor: ConductorAgent;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  turns: ConductorSessionTurn[];
  autonomousTurns: number;
  maxTurns: number;
}): Promise<ConductorSendResult> {
  const issueContext = await fetchIssueContext(input.options.issueUrl);
  const message = compileConductorInitialMessage({
    repoRoot: input.options.repoRoot,
    issueContext,
    materials: mergeConductorMaterials(
      mergeProfileMaterials(input.options.materials, input.options.profile),
      input.options.briefing,
    ),
    turn: 1,
    autonomousTurns: input.autonomousTurns,
    maxTurns: input.maxTurns,
    runningWorkers: input.workerSession.runtime.listRunning(),
    pendingPermissions: input.permissionPipeline.pending.list(),
    followUp: input.options.resumeAgentId
      ? '前回の続きです。Issue / PR の最新状態を踏まえ、次に必要な判断を行ってください。'
      : undefined,
  });

  return runEventConductorSend({
    message,
    conductorTurn: 1,
    conductor: input.conductor,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    escalations: input.escalations,
    turns: input.turns,
    options: input.options,
  });
}

async function runEventConductorSend(input: {
  message: string;
  conductorTurn: number;
  conductor: ConductorAgent;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  turns: ConductorSessionTurn[];
  options: RunConductorSessionOptions;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const escalationsBefore = input.escalations.length;

  const sendResult = await input.conductor.send(input.message);

  const sessionTurn: ConductorSessionTurn = {
    turn: input.conductorTurn,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    workerDispatches: input.workerDispatches.length - workersBefore,
    workerFailures: input.workerFailures.length - failuresBefore,
    escalations: input.escalations.length - escalationsBefore,
  };
  input.turns.push(sessionTurn);
  input.options.onTurnComplete?.(sessionTurn);

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

function mergeProfileMaterials(
  materials: ConductorMaterial[] | undefined,
  profile: Profile | undefined,
): ConductorMaterial[] | undefined {
  const fromProfile =
    profile?.materials?.map((material, index) => ({
      id: material.id ?? `profile-material-${index + 1}`,
      title: material.title ?? material.id ?? `profile-material-${index + 1}`,
      content: material.content!,
    })) ?? [];

  const merged = [...(materials ?? []), ...fromProfile];
  return merged.length > 0 ? merged : undefined;
}
