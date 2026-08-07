import type { ReviewerDispatchResult } from '../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { buildHumanGuidancePrompt } from '../escalation/build-human-guidance-prompt.js';
import { buildMaxTurnsEscalationRequest } from '../escalation/build-max-turns-escalation.js';
import { createPermissionAskHandler } from '../escalation/create-permission-ask-handler.js';
import type {
  EscalationRecord,
  HumanInquiryHandler,
} from '../escalation/human-inquiry.js';
import { createEnvFallbackHumanInquiryHandler } from '../escalation/resolve-human-inquiry.js';
import { fetchIssueContext } from '../github/issue-context.js';
import {
  PermissionBroker,
  type PermissionAskHandler,
} from '../permission/permission-broker.js';
import type { PermissionPolicyRules } from '../permission/permission-policy.js';
import { buildConductorFollowUpPrompt } from './build-conductor-follow-up-prompt.js';
import { buildConductorPrompt } from './build-conductor-prompt.js';
import { ConductorAgent } from './conductor-agent.js';
import type { ConductorSendResult } from './conductor-agent.js';
import { createDispatchTools } from './dispatch-tools.js';
import {
  DEFAULT_MAX_ISSUE_TURNS,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
  type IssueLoopStopReason,
} from './issue-loop.js';

export interface RunIssueSessionOptions {
  issueUrl: string;
  repoRoot: string;
  conductorCwd?: string;
  briefing?: string;
  resumeAgentId?: string;
  apiKey?: string;
  modelId?: string;
  maxTurns?: number;
  permissionPolicy?: PermissionPolicyRules;
  permissionBroker?: PermissionBroker;
  onPermissionAsk?: PermissionAskHandler;
  onHumanInquiry?: HumanInquiryHandler;
  /** max turns 到達時に人間へ問い合わせ、回答があればボーナスターンを実行する。 */
  escalateOnMaxTurns?: boolean;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
  onReviewerDispatched?: (result: ReviewerDispatchResult) => void;
  onTurnComplete?: (turn: IssueSessionTurn) => void;
  onEscalated?: (record: EscalationRecord) => void;
}

export interface IssueSessionTurn {
  turn: number;
  runId: string;
  status: ConductorSendResult['status'];
  result?: string;
  error?: ConductorSendResult['error'];
  workerDispatches: number;
  reviewerDispatches: number;
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
  reviewerDispatches: ReviewerDispatchResult[];
  escalations: EscalationRecord[];
}

export async function runIssueSession(
  options: RunIssueSessionOptions,
): Promise<IssueSessionResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_ISSUE_TURNS;
  const escalateOnMaxTurns = options.escalateOnMaxTurns ?? true;
  const workerDispatches: WorkerDispatchResult[] = [];
  const reviewerDispatches: ReviewerDispatchResult[] = [];
  const escalations: EscalationRecord[] = [];
  const turns: IssueSessionTurn[] = [];

  const onHumanInquiry =
    options.onHumanInquiry ?? createEnvFallbackHumanInquiryHandler();
  const onPermissionAsk =
    options.onPermissionAsk ?? createPermissionAskHandler(onHumanInquiry);

  const permissionBroker =
    options.permissionBroker ??
    new PermissionBroker({
      policy: options.permissionPolicy,
      onAsk: onPermissionAsk,
    });
  const permissionHandler = permissionBroker.createHandler('conductor-worker');

  const dispatchTools = createDispatchTools({
    repoRoot: options.repoRoot,
    permissionHandler,
    onWorkerDispatched: (result) => {
      workerDispatches.push(result);
      options.onWorkerDispatched?.(result);
    },
    onReviewerDispatched: (result) => {
      reviewerDispatches.push(result);
      options.onReviewerDispatched?.(result);
    },
  });

  const escalationTools = createAskHumanTool({
    onAsk: onHumanInquiry,
    onEscalated: (record) => {
      escalations.push(record);
      options.onEscalated?.(record);
    },
  });

  const conductorOptions = {
    cwd: options.conductorCwd ?? process.cwd(),
    apiKey: options.apiKey,
    modelId: options.modelId,
    customTools: { ...dispatchTools, ...escalationTools },
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
    for (let turn = 1; turn <= maxTurns; turn++) {
      lastSendResult = await runConductorTurn({
        turn,
        maxTurns,
        options,
        conductor,
        workerDispatches,
        reviewerDispatches,
        escalations,
        turns,
      });

      const sessionTurn = turns[turns.length - 1]!;
      const loopState = {
        turn,
        maxTurns,
        lastStatus: lastSendResult.status,
        dispatchesThisTurn:
          sessionTurn.workerDispatches + sessionTurn.reviewerDispatches,
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
        lastSendResult = await runBonusTurn({
          conductor,
          prompt: buildHumanGuidancePrompt(guidance),
          turn: turns.length + 1,
          workerDispatches,
          reviewerDispatches,
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
        reviewerDispatches,
        escalations,
      };
    }
  } finally {
    await conductor.close();
  }
}

async function runConductorTurn(input: {
  turn: number;
  maxTurns: number;
  options: RunIssueSessionOptions;
  conductor: ConductorAgent;
  workerDispatches: WorkerDispatchResult[];
  reviewerDispatches: ReviewerDispatchResult[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const reviewersBefore = input.reviewerDispatches.length;
  const escalationsBefore = input.escalations.length;

  const issueContext = await fetchIssueContext(input.options.issueUrl);
  const prompt = buildPromptForTurn({
    turn: input.turn,
    maxTurns: input.maxTurns,
    issueContext,
    options: input.options,
    workerDispatches: input.workerDispatches,
    reviewerDispatches: input.reviewerDispatches,
    escalations: input.escalations,
  });

  const sendResult = await input.conductor.send(prompt);

  const sessionTurn: IssueSessionTurn = {
    turn: input.turn,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    workerDispatches: input.workerDispatches.length - workersBefore,
    reviewerDispatches: input.reviewerDispatches.length - reviewersBefore,
    escalations: input.escalations.length - escalationsBefore,
  };
  input.turns.push(sessionTurn);
  input.options.onTurnComplete?.(sessionTurn);

  return sendResult;
}

async function runBonusTurn(input: {
  conductor: ConductorAgent;
  prompt: string;
  turn: number;
  workerDispatches: WorkerDispatchResult[];
  reviewerDispatches: ReviewerDispatchResult[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
  options: RunIssueSessionOptions;
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const reviewersBefore = input.reviewerDispatches.length;
  const escalationsBefore = input.escalations.length;

  const sendResult = await input.conductor.send(input.prompt);

  const sessionTurn: IssueSessionTurn = {
    turn: input.turn,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    workerDispatches: input.workerDispatches.length - workersBefore,
    reviewerDispatches: input.reviewerDispatches.length - reviewersBefore,
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
  reviewerDispatches: ReviewerDispatchResult[];
  escalations: EscalationRecord[];
}): string {
  const {
    turn,
    options,
    issueContext,
    workerDispatches,
    reviewerDispatches,
    escalations,
  } = input;

  if (turn === 1) {
    return buildConductorPrompt({
      issueContext,
      repoRoot: options.repoRoot,
      briefing: options.briefing,
      followUp: options.resumeAgentId
        ? '前回の続きです。Issue / PR の最新状態を踏まえ、次に必要な dispatch を判断してください。'
        : undefined,
    });
  }

  return buildConductorFollowUpPrompt({
    issueContext,
    repoRoot: options.repoRoot,
    turn,
    maxTurns: input.maxTurns,
    workerDispatches,
    reviewerDispatches,
    escalations,
  });
}
