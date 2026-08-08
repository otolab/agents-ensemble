import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { applyOperatorMessage } from '../escalation/apply-operator-message.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { formatOpenQuestionAnsweredReport, joinOperatorInput } from '../escalation/format-registry-update.js';
import { createOpenQuestionListTools } from '../escalation/open-question-list-tools.js';
import { buildHumanGuidancePrompt } from '../escalation/build-human-guidance-prompt.js';
import { buildMaxTurnsEscalationRequest } from '../escalation/build-max-turns-escalation.js';
import type {
  EscalationRecord,
  HumanInquiryHandler,
} from '../escalation/human-inquiry.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import { SessionDialogueLog } from '../escalation/dialogue-log.js';
import type { DialogueEntry } from '../escalation/dialogue-log.js';
import { createEnvFallbackHumanInquiryHandler } from '../escalation/resolve-human-inquiry.js';
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
  turn: number;
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
  onHumanInquiry?: HumanInquiryHandler;
  /** 各ターン開始前のオペレータ入力（open question への回答など）。 */
  onOperatorInput?: (
    context: OperatorInputContext,
  ) => string | Promise<string | undefined> | undefined;
  /** max turns 到達時に人間へ問い合わせ、回答があればボーナスターンを実行する。 */
  escalateOnMaxTurns?: boolean;
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
  const escalateOnMaxTurns = options.escalateOnMaxTurns ?? true;
  const workerDispatches: WorkerDispatchResult[] = [];
  const workerFailures: WorkerFailureRecord[] = [];
  const escalations: EscalationRecord[] = [];
  const turns: IssueSessionTurn[] = [];
  const openQuestions = new OpenQuestionRegistry();
  const dialogueLog = new SessionDialogueLog();

  const onHumanInquiry =
    options.onHumanInquiry ?? createEnvFallbackHumanInquiryHandler();

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
    let turn = 0;
    while (true) {
      turn++;

      lastSendResult = await runConductorTurn({
        turn,
        maxTurns,
        options,
        conductor,
        workerSession,
        permissionPipeline,
        openQuestions,
        dialogueLog,
        workerDispatches,
        workerFailures,
        escalations,
        turns,
      });

      const sessionTurn = turns[turns.length - 1]!;
      const loopState = {
        turn,
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

    const result = buildResult();

    if (stopReason === 'max_turns' && escalateOnMaxTurns) {
      const guidance = await maybeEscalateOnMaxTurns(onHumanInquiry, result);
      if (guidance) {
        const issueContext = await fetchIssueContext(options.issueUrl);
        lastSendResult = await runBonusTurn({
          conductor,
          workerSession,
          prompt: buildHumanGuidancePrompt({
            guidance,
            repoRoot: options.repoRoot,
            issueContext,
          }),
          turn: turns.length + 1,
        workerDispatches,
        workerFailures,
        escalations,
        turns,
        options,
      });
        stopReason = 'completed';
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

async function runConductorTurn(input: {
  turn: number;
  maxTurns: number;
  options: RunIssueSessionOptions;
  conductor: ConductorAgent;
  workerSession: WorkerSession;
  permissionPipeline: PermissionPipeline;
  openQuestions: OpenQuestionRegistry;
  dialogueLog: SessionDialogueLog;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const escalationsBefore = input.escalations.length;

  let humanGuidance: string | undefined;
  if (input.turn > 1 && input.options.onOperatorInput) {
    const operatorMessage = await input.options.onOperatorInput({
      turn: input.turn,
      openQuestions: input.openQuestions.listOpen(),
    });
    if (operatorMessage?.trim()) {
      input.dialogueLog.appendOperatorMessage(input.turn, operatorMessage);
      const applied = applyOperatorMessage(
        input.openQuestions,
        input.dialogueLog,
        operatorMessage,
      );
      humanGuidance =
        applied.answered.length > 0
          ? joinOperatorInput([
              applied.generalGuidance,
              ...applied.answered.map(formatOpenQuestionAnsweredReport),
            ])
          : joinOperatorInput([
              applied.generalGuidance ?? operatorMessage.trim(),
            ]);
      for (const answered of applied.answered) {
        recordAnsweredOpenQuestion(input, answered);
      }
    }
  }

  const issueContext = await fetchIssueContext(input.options.issueUrl);
  const prompt = buildPromptForTurn({
    turn: input.turn,
    maxTurns: input.maxTurns,
    issueContext,
    options: input.options,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    escalations: input.escalations,
    runningWorkers: input.workerSession.runtime.listRunning(),
    pendingPermissions: input.permissionPipeline.pending.list(),
    humanGuidance,
  });

  const sendResult = await input.conductor.send(prompt);

  const sessionTurn: IssueSessionTurn = {
    turn: input.turn,
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

async function runBonusTurn(input: {
  conductor: ConductorAgent;
  workerSession: WorkerSession;
  prompt: string;
  turn: number;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
  options: RunIssueSessionOptions;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const escalationsBefore = input.escalations.length;

  const sendResult = await input.conductor.send(input.prompt);

  const sessionTurn: IssueSessionTurn = {
    turn: input.turn,
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

async function maybeEscalateOnMaxTurns(
  onHumanInquiry: HumanInquiryHandler,
  result: IssueSessionResult,
): Promise<string | undefined> {
  const request = buildMaxTurnsEscalationRequest(result);
  const response = await onHumanInquiry(request);
  const guidance = response.answer.trim();
  return guidance || undefined;
}

function buildPromptForTurn(input: {
  turn: number;
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
    turn,
    options,
    issueContext,
    workerDispatches,
    workerFailures,
    escalations,
    runningWorkers,
    pendingPermissions,
    humanGuidance,
  } = input;

  if (turn === 1) {
    return buildConductorPrompt({
      issueContext,
      repoRoot: options.repoRoot,
      briefing: options.briefing,
      materials: mergeProfileMaterials(options.materials, options.profile),
      turn: 1,
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
    turn,
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
