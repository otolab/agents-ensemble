import type { ReviewerDispatchResult } from '../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
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
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
  onReviewerDispatched?: (result: ReviewerDispatchResult) => void;
  onTurnComplete?: (turn: IssueSessionTurn) => void;
  /** Stage 4 接続用: max turns 到達時に呼ばれる。 */
  onMaxTurnsReached?: (result: IssueSessionResult) => void;
}

export interface IssueSessionTurn {
  turn: number;
  runId: string;
  status: ConductorSendResult['status'];
  result?: string;
  error?: ConductorSendResult['error'];
  workerDispatches: number;
  reviewerDispatches: number;
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
}

export async function runIssueSession(
  options: RunIssueSessionOptions,
): Promise<IssueSessionResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_ISSUE_TURNS;
  const workerDispatches: WorkerDispatchResult[] = [];
  const reviewerDispatches: ReviewerDispatchResult[] = [];
  const turns: IssueSessionTurn[] = [];

  const permissionBroker =
    options.permissionBroker ??
    new PermissionBroker({
      policy: options.permissionPolicy,
      onAsk: options.onPermissionAsk,
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

  const conductorOptions = {
    cwd: options.conductorCwd ?? process.cwd(),
    apiKey: options.apiKey,
    modelId: options.modelId,
    customTools: dispatchTools,
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
      const workersBefore = workerDispatches.length;
      const reviewersBefore = reviewerDispatches.length;

      const issueContext = await fetchIssueContext(options.issueUrl);
      const prompt = buildPromptForTurn({
        turn,
        maxTurns,
        issueContext,
        options,
        workerDispatches,
        reviewerDispatches,
      });

      lastSendResult = await conductor.send(prompt);

      const workerCount = workerDispatches.length - workersBefore;
      const reviewerCount = reviewerDispatches.length - reviewersBefore;
      const sessionTurn: IssueSessionTurn = {
        turn,
        runId: lastSendResult.runId,
        status: lastSendResult.status,
        result: lastSendResult.result,
        error: lastSendResult.error,
        workerDispatches: workerCount,
        reviewerDispatches: reviewerCount,
      };
      turns.push(sessionTurn);
      options.onTurnComplete?.(sessionTurn);

      const loopState = {
        turn,
        maxTurns,
        lastStatus: lastSendResult.status,
        dispatchesThisTurn: workerCount + reviewerCount,
      };

      stopReason = resolveIssueLoopStopReason(loopState);

      if (shouldStopIssueLoop(loopState)) {
        if (stopReason === 'max_turns') {
          options.onMaxTurnsReached?.(buildResult());
        }
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
        reviewerDispatches,
      };
    }
  } finally {
    await conductor.close();
  }
}

function buildPromptForTurn(input: {
  turn: number;
  maxTurns: number;
  issueContext: Awaited<ReturnType<typeof fetchIssueContext>>;
  options: RunIssueSessionOptions;
  workerDispatches: WorkerDispatchResult[];
  reviewerDispatches: ReviewerDispatchResult[];
}): string {
  const { turn, options, issueContext, workerDispatches, reviewerDispatches } =
    input;

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
  });
}
