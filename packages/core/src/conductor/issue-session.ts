import type { ReviewerDispatchResult } from '../dispatch/reviewer-dispatch.js';
import type { LibrarianDispatchResult } from '../dispatch/librarian-dispatch.js';
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
import { ConductorInbox } from '../runtime/conductor-inbox.js';
import { startInboxProcessor } from '../runtime/inbox-processor.js';
import { WorkerRuntime } from '../runtime/worker-runtime.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import { buildConductorFollowUpPrompt } from './build-conductor-follow-up-prompt.js';
import { buildConductorPrompt } from './build-conductor-prompt.js';
import type { ConductorMaterial } from './prompt/types.js';
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
  materials?: ConductorMaterial[];
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
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
  onReviewerDispatched?: (result: ReviewerDispatchResult) => void;
  onLibrarianDispatched?: (result: LibrarianDispatchResult) => void;
  onTurnComplete?: (turn: IssueSessionTurn) => void;
  onEscalated?: (record: EscalationRecord) => void;
}

export interface IssueSessionTurn {
  turn: number;
  runId: string;
  status: ConductorSendResult['status'];
  result?: string;
  error?: ConductorSendResult['error'];
  /** 非同期 dispatch の開始数（このターン内）。 */
  workerDispatchStarts: number;
  /** worker 完了数（このターン内）。 */
  workerDispatches: number;
  /** worker 失敗数（このターン内）。 */
  workerFailures: number;
  reviewerDispatches: number;
  librarianDispatches: number;
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
  reviewerDispatches: ReviewerDispatchResult[];
  librarianDispatches: LibrarianDispatchResult[];
  escalations: EscalationRecord[];
}

export async function runIssueSession(
  options: RunIssueSessionOptions,
): Promise<IssueSessionResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_ISSUE_TURNS;
  const escalateOnMaxTurns = options.escalateOnMaxTurns ?? true;
  const workerDispatches: WorkerDispatchResult[] = [];
  const workerFailures: WorkerFailureRecord[] = [];
  const reviewerDispatches: ReviewerDispatchResult[] = [];
  const librarianDispatches: LibrarianDispatchResult[] = [];
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

  const inbox = new ConductorInbox();
  const inboxProcessor = startInboxProcessor(inbox, {
    decidePermission: (request, workerId) =>
      permissionBroker.decide(request.raw, workerId),
    onWorkerCompleted: (result) => {
      workerDispatches.push(result);
      options.onWorkerDispatched?.(result);
    },
    onWorkerFailed: (failure) => {
      workerFailures.push(failure);
      options.onWorkerFailed?.(failure);
    },
  });
  const workerRuntime = new WorkerRuntime({ inbox });

  const turnMetrics = { workerDispatchStarts: 0 };

  const dispatchTools = createDispatchTools({
    repoRoot: options.repoRoot,
    workerRuntime,
    permissionHandler: permissionBroker.createHandler('conductor-reviewer'),
    onWorkerStarted: () => {
      turnMetrics.workerDispatchStarts++;
    },
    onReviewerDispatched: (result) => {
      reviewerDispatches.push(result);
      options.onReviewerDispatched?.(result);
    },
    onLibrarianDispatched: (result) => {
      librarianDispatches.push(result);
      options.onLibrarianDispatched?.(result);
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
    let turn = 0;
    while (true) {
      turn++;
      turnMetrics.workerDispatchStarts = 0;

      lastSendResult = await runConductorTurn({
        turn,
        maxTurns,
        options,
        conductor,
        workerRuntime,
        workerDispatches,
        workerFailures,
        reviewerDispatches,
        librarianDispatches,
        escalations,
        turns,
        turnMetrics,
      });

      const sessionTurn = turns[turns.length - 1]!;
      const loopState = {
        turn,
        maxTurns,
        lastStatus: lastSendResult.status,
        dispatchesThisTurn:
          sessionTurn.workerDispatchStarts +
          sessionTurn.workerDispatches +
          sessionTurn.workerFailures +
          sessionTurn.reviewerDispatches +
          sessionTurn.librarianDispatches,
        runningWorkers: workerRuntime.runningCount,
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
        turnMetrics.workerDispatchStarts = 0;
        const issueContext = await fetchIssueContext(options.issueUrl);
        lastSendResult = await runBonusTurn({
          conductor,
          workerRuntime,
          prompt: buildHumanGuidancePrompt({
            guidance,
            repoRoot: options.repoRoot,
            issueContext,
          }),
          turn: turns.length + 1,
          workerDispatches,
          workerFailures,
          reviewerDispatches,
          librarianDispatches,
          escalations,
          turns,
          options,
          turnMetrics,
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
        reviewerDispatches,
        librarianDispatches,
        escalations,
      };
    }
  } finally {
    await workerRuntime.waitForIdle();
    await inboxProcessor.stop();
    await conductor.close();
  }
}

async function runConductorTurn(input: {
  turn: number;
  maxTurns: number;
  options: RunIssueSessionOptions;
  conductor: ConductorAgent;
  workerRuntime: WorkerRuntime;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  reviewerDispatches: ReviewerDispatchResult[];
  librarianDispatches: LibrarianDispatchResult[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
  turnMetrics: { workerDispatchStarts: number };
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const reviewersBefore = input.reviewerDispatches.length;
  const librariansBefore = input.librarianDispatches.length;
  const escalationsBefore = input.escalations.length;
  const workerDispatchStartsBefore = input.turnMetrics.workerDispatchStarts;

  const issueContext = await fetchIssueContext(input.options.issueUrl);
  const prompt = buildPromptForTurn({
    turn: input.turn,
    maxTurns: input.maxTurns,
    issueContext,
    options: input.options,
    workerDispatches: input.workerDispatches,
    workerFailures: input.workerFailures,
    reviewerDispatches: input.reviewerDispatches,
    librarianDispatches: input.librarianDispatches,
    escalations: input.escalations,
    runningWorkers: input.workerRuntime.listRunning(),
  });

  const sendResult = await input.conductor.send(prompt);

  const sessionTurn: IssueSessionTurn = {
    turn: input.turn,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    workerDispatchStarts:
      input.turnMetrics.workerDispatchStarts - workerDispatchStartsBefore,
    workerDispatches: input.workerDispatches.length - workersBefore,
    workerFailures: input.workerFailures.length - failuresBefore,
    reviewerDispatches: input.reviewerDispatches.length - reviewersBefore,
    librarianDispatches: input.librarianDispatches.length - librariansBefore,
    escalations: input.escalations.length - escalationsBefore,
  };
  input.turns.push(sessionTurn);
  input.options.onTurnComplete?.(sessionTurn);

  return sendResult;
}

async function runBonusTurn(input: {
  conductor: ConductorAgent;
  workerRuntime: WorkerRuntime;
  prompt: string;
  turn: number;
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  reviewerDispatches: ReviewerDispatchResult[];
  librarianDispatches: LibrarianDispatchResult[];
  escalations: EscalationRecord[];
  turns: IssueSessionTurn[];
  options: RunIssueSessionOptions;
  turnMetrics: { workerDispatchStarts: number };
}): Promise<ConductorSendResult> {
  const workersBefore = input.workerDispatches.length;
  const failuresBefore = input.workerFailures.length;
  const reviewersBefore = input.reviewerDispatches.length;
  const librariansBefore = input.librarianDispatches.length;
  const escalationsBefore = input.escalations.length;
  const workerDispatchStartsBefore = input.turnMetrics.workerDispatchStarts;

  const sendResult = await input.conductor.send(input.prompt);

  const sessionTurn: IssueSessionTurn = {
    turn: input.turn,
    runId: sendResult.runId,
    status: sendResult.status,
    result: sendResult.result,
    error: sendResult.error,
    workerDispatchStarts:
      input.turnMetrics.workerDispatchStarts - workerDispatchStartsBefore,
    workerDispatches: input.workerDispatches.length - workersBefore,
    workerFailures: input.workerFailures.length - failuresBefore,
    reviewerDispatches: input.reviewerDispatches.length - reviewersBefore,
    librarianDispatches: input.librarianDispatches.length - librariansBefore,
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
  reviewerDispatches: ReviewerDispatchResult[];
  librarianDispatches: LibrarianDispatchResult[];
  escalations: EscalationRecord[];
  runningWorkers: ReturnType<WorkerRuntime['listRunning']>;
}): string {
  const {
    turn,
    options,
    issueContext,
    workerDispatches,
    workerFailures,
    reviewerDispatches,
    librarianDispatches,
    escalations,
    runningWorkers,
  } = input;

  if (turn === 1) {
    return buildConductorPrompt({
      issueContext,
      repoRoot: options.repoRoot,
      briefing: options.briefing,
      materials: options.materials,
      turn: 1,
      maxTurns: input.maxTurns,
      runningWorkers,
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
    workerFailures,
    reviewerDispatches,
    librarianDispatches,
    escalations,
    runningWorkers,
  });
}
