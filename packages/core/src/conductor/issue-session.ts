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
import { buildConductorFollowUpPrompt } from './build-conductor-follow-up-prompt.js';
import { buildConductorPrompt } from './build-conductor-prompt.js';
import type { ConductorMaterial } from './prompt/types.js';
import { ConductorAgent } from './conductor-agent.js';
import type { ConductorSendResult } from './conductor-agent.js';
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

export interface RunIssueSessionOptions {
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
  onTurnComplete?: (turn: IssueSessionTurn) => void;
  onEscalated?: (record: EscalationRecord) => void;
  onOpenQuestionEnqueued?: (question: OpenQuestion) => void;
}

export interface IssueSessionTurn {
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

export interface IssueSessionResult {
  agentId: string;
  issueUrl: string;
  repoRoot: string;
  turnCount: number;
  stopReason: IssueLoopStopReason;
  turns: IssueSessionTurn[];
  lastRunStatus: string;
  lastResult?: string;
  lastError?: { message: string; code?: string };
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  openQuestions: OpenQuestion[];
  dialogueLog: DialogueEntry[];
}

export async function runIssueSession(
  options: RunIssueSessionOptions,
): Promise<IssueSessionResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_ISSUE_TURNS;
  const workerDispatches: WorkerDispatchResult[] = [];
  const workerFailures: WorkerFailureRecord[] = [];
  const escalations: EscalationRecord[] = [];
  const turns: IssueSessionTurn[] = [];
  const openQuestions = new OpenQuestionRegistry();
  const dialogueLog = new SessionDialogueLog();

  const permissionPipeline =
    options.permissionPipeline ??
    new PermissionPipeline({ policy: options.permissionPolicy });

  const workerSession = new WorkerSession({
    issueUrl: options.issueUrl,
    repoRoot: options.repoRoot,
    workers: profileWorkersToSessionSpecs(options.profile),
    permissionPipeline,
    ...(options.dispatchWorker ? { dispatchWorker: options.dispatchWorker } : {}),
    onWorkerCompleted: (result) => {
      workerDispatches.push(result);
      options.onWorkerDispatched?.(result);
    },
    onWorkerFailed: (failure) => {
      workerFailures.push(failure);
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

      let humanGuidance: string | undefined;
      if (openQuestions.openCount === 0 && options.onOperatorInput) {
        const operatorPhase = await collectOperatorInput({
          conductorTurn: turns.length + 1,
          autonomousTurns,
          maxTurns,
          options,
          openQuestions,
          dialogueLog,
          escalations,
        });
        if (operatorPhase.received) {
          autonomousTurns = 0;
          humanGuidance = operatorPhase.humanGuidance;
        }
      }

      lastSendResult = await runConductorSend({
        conductorTurn: turns.length + 1,
        autonomousTurns,
        maxTurns,
        humanGuidance,
        options,
        conductor,
        workerSession,
        permissionPipeline,
        workerDispatches,
        workerFailures,
        escalations,
        turns,
      });
      autonomousTurns++;

      const sessionTurn = turns[turns.length - 1]!;
      const loopState = {
        autonomousTurns,
        maxTurns,
        lastStatus: lastSendResult.status,
        dispatchesThisTurn:
          sessionTurn.workerDispatches + sessionTurn.workerFailures,
        runningWorkers: workerSession.runtime.runningCount,
        pendingPermissions: permissionPipeline.pending.size,
        openQuestions: openQuestions.openCount,
      };

      stopReason = resolveIssueLoopStopReason(loopState);

      if (shouldStopIssueLoop(loopState)) {
        break;
      }
    }

    return buildResult();

    function buildResult(): IssueSessionResult {
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
  options: RunIssueSessionOptions;
  openQuestions: OpenQuestionRegistry;
  dialogueLog: SessionDialogueLog;
  escalations: EscalationRecord[];
}): Promise<{ received: boolean; humanGuidance?: string }> {
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
  const humanGuidance =
    applied.answered.length > 0
      ? joinOperatorInput([
          applied.generalGuidance,
          ...applied.answered.map(formatOpenQuestionAnsweredReport),
        ])
      : joinOperatorInput([applied.generalGuidance ?? operatorMessage.trim()]);

  for (const answered of applied.answered) {
    recordAnsweredOpenQuestion(input, answered);
  }

  return { received: true, humanGuidance };
}

async function runConductorSend(input: {
  conductorTurn: number;
  autonomousTurns: number;
  maxTurns: number;
  humanGuidance?: string;
  options: RunIssueSessionOptions;
  conductor: ConductorAgent;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const escalationsBefore = input.escalations.length;

  const issueContext = await fetchIssueContext(input.options.issueUrl);
  const prompt = buildPromptForTurn({
    conductorTurn: input.conductorTurn,
    autonomousTurns: input.autonomousTurns,
    maxTurns: input.maxTurns,
    issueContext,
    options: input.options,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    escalations: input.escalations,
    runningWorkers: input.workerSession.runtime.listRunning(),
    pendingPermissions: input.permissionPipeline.pending.list(),
    humanGuidance: input.humanGuidance,
  });

  const sendResult = await input.conductor.send(prompt);

  const sessionTurn: IssueSessionTurn = {
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

function buildPromptForTurn(input: {
  conductorTurn: number;
  autonomousTurns: number;
  maxTurns: number;
  issueContext: Awaited<ReturnType<typeof fetchIssueContext>>;
  options: RunIssueSessionOptions;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  runningWorkers: ReturnType<WorkerSession['runtime']['listRunning']>;
  pendingPermissions: ReturnType<PermissionPipeline['pending']['list']>;
  humanGuidance?: string;
}): string {
  const {
    conductorTurn,
    autonomousTurns,
    options,
    issueContext,
    workerDispatches,
    workerFailures,
    escalations,
    runningWorkers,
    pendingPermissions,
    humanGuidance,
  } = input;

  if (conductorTurn === 1) {
    return buildConductorPrompt({
      issueContext,
      repoRoot: options.repoRoot,
      briefing: options.briefing,
      materials: mergeProfileMaterials(options.materials, options.profile),
      turn: conductorTurn,
      autonomousTurns,
      maxTurns: input.maxTurns,
      runningWorkers,
      pendingPermissions,
      followUp: options.resumeAgentId
        ? '前回の続きです。Issue / PR の最新状態を踏まえ、次に必要な判断を行ってください。'
        : undefined,
    });
  }

  return buildConductorFollowUpPrompt({
    issueContext,
    repoRoot: options.repoRoot,
    turn: conductorTurn,
    autonomousTurns,
    maxTurns: input.maxTurns,
    workerDispatches,
    workerFailures,
    escalations,
    runningWorkers,
    pendingPermissions,
    humanGuidance,
  });
}

function recordAnsweredOpenQuestion(
  input: {
    escalations: EscalationRecord[];
    options: RunIssueSessionOptions;
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
