import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import {
  loadEnsembleConfig,
} from '../config/load-ensemble-config.js';
import type { EnsembleConfig } from '../config/types.js';
import { resolveMcpServersForSdk } from '../mcp/load-mcp-config.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { createOpenQuestionListTools } from '../escalation/open-question-list-tools.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import type { PermissionPolicyRules } from '../permission/permission-policy.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import {
  createPermissionDeadlockMonitor,
  type PermissionDeadlockMonitor,
} from '../permission/permission-deadlock-monitor.js';
import { createResolvePermissionTool } from '../permission/resolve-permission-tool.js';
import type { Profile, ResolvedProfile } from '../profile/types.js';
import type { DefaultAcpResolutionOptions, AcpSpawnFingerprint } from '../acp/resolve-acp-spawn.js';
import {
  acpSpawnFingerprint,
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from '../acp/resolve-acp-spawn.js';
import {
  finalizeResolvedAcpSpawn,
  validateWorkerAcpPrerequisites,
} from '../acp/validate-acp-preset-prerequisites.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import {
  profileWorkersToSessionSpecs,
  sessionStateFromProfile,
  type SessionWorkerSpec,
} from '../profile/types.js';
import { WorkerSession } from '../runtime/worker-session.js';
import { createPromptWorkerTool } from '../dispatch/prompt-worker-tool.js';
import { createWorkerStatusTools } from '../dispatch/worker-status-tool.js';
import { createSessionUsageTools } from '../dispatch/session-usage-tool.js';
import type { ConnectWorkerAcpFn } from '../dispatch/worker-acp-session.js';
import { parseIssueUrl, type IssueRef } from '../issue/issue-ref.js';
import {
  resolveWorkerWorkspace,
  removeWorkerWorktree,
  type WorkerWorktreeMode,
  type WorktreeRef,
} from '../worktree/worktree.js';
import { WorkerOutboundQueue } from '../runtime/worker-outbound-queue.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import { ConductorAgent, type ConductorAgentOptions } from './conductor-agent.js';
import type { ConductorSendResult } from './conductor-agent.js';
import {
  formatConductorAuthRecoveryHint,
  isConductorSendAuthError,
} from './conductor-auth.js';
import type { ConductorAgentHandle } from './conductor-send-reconnect.js';
import { SessionLogger } from './session/session-logger.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import {
  operatorInputMaxTurns,
  resolveMaxTurns,
  type IssueLoopStopReason,
} from './session-policy.js';
import { runConductorSessionDriver } from './conductor-session-driver.js';
import { isOperatorExitCommand } from './operator-exit.js';
import {
  assertSessionSidecarMatches,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
  type SessionSidecar,
} from '../session/session-sidecar.js';
import type { SessionUsageSummary } from '../usage/types.js';
import { enrichSessionUsageWithCost } from '../usage/enrich-session-usage-cost.js';
import { SessionUsageTracker } from '../usage/session-usage-tracker.js';
import type { OperatorInputBinding } from './operator-input-binding.js';
import { submitOperatorInput } from './submit-operator-input.js';
import {
  createGitHubMonitor,
  type GitHubMonitor,
} from '../github/github-monitor.js';
import { resolveGitHubMonitorEnabled } from '../config/resolve-settings.js';
import { GitHubMonitorError } from '../github/github-monitor-error.js';
import { GITHUB_AUTH_HINT } from '../github/github-auth.js';
import { resolveGitHubAuthToken } from '../github/resolve-github-auth-token.js';
import type { GitHubMonitorCursor } from '../github/github-monitor-cursor.js';

export type { OperatorInputContext } from './operator-input-binding.js';
export type {
  OperatorInputBinding,
  OperatorInputBindingApi,
} from './operator-input-binding.js';

export interface RunConductorSessionOptions {
  issueUrl: string;
  repoRoot: string;
  conductorCwd?: string;
  /** テスト用。未指定時は loadEnsembleConfig(repoRoot) で解決する。 */
  ensembleConfig?: EnsembleConfig;
  /** 作業手順・worker 定義。未指定時は loadProfile でデフォルトを解決する。 */
  profile: ResolvedProfile;
  profilePath?: string;
  resumeAgentId?: string;
  apiKey?: string;
  modelId?: string;
  maxTurns?: number;
  permissionPolicy?: PermissionPolicyRules;
  permissionPipeline?: PermissionPipeline;
  /**
   * 非ブロッキングのオペレータ入力。`submit` で `operator.message` をキューへ積む。
   */
  bindOperatorInput?: OperatorInputBinding;
  /**
   * conductor `agent.send` が error でもループを継続する（TTY 等でオペレータが再試行できるとき）。
   * 非 TTY / CI では false のままにすること。
   */
  continueOnConductorError?: boolean;
  /**
   * 自律ループ停止後も harness を維持し、オペレータの `/exit` または追加指示を待つ。
   * CLI の TTY デフォルト。非 TTY / CI では false。
   */
  waitForOperatorExit?: boolean;
  /** `waitForOperatorExit` 時、自律ループ停止直後に呼ぶ（CLI の案内表示等）。 */
  onPostLoopWait?: () => void;
  /** integration 等で Fake ACP に差し替える。未指定時は実 `agent acp`。 */
  connectAcp?: ConnectWorkerAcpFn;
  /** profile / worker に ACP 未指定時のデフォルト解決（CLI > env > cursor）。 */
  defaultAcp?: DefaultAcpResolutionOptions;
  /**
   * Conductor が worker 向け作業ディレクトリをどう用意するか。
   * セッション開始時に 1 回だけ resolve し、全 worker が共有する。
   */
  workerWorktreeMode?: WorkerWorktreeMode;
  /** テスト用。未指定時は `workerWorktreeMode` から resolve する。 */
  workerWorktree?: WorktreeRef;
  /** integration の共有 bridge 注入時は false。 */
  ownsWorkerAcpConnections?: boolean;
  /** テスト用。SDK が返さない context limit の代替（利用率算出用）。 */
  contextLimitTokens?: number;
  onWorkerDispatched?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
  /** `agent.send` 完了ごと（CLI 進捗ログ等）。 */
  onSendComplete?: (info: {
    sendCount: number;
    runId: string;
    status: ConductorSendResult['status'];
    result?: string;
    error?: ConductorSendResult['error'];
    workerDispatches: number;
    workerFailures: number;
  }) => void;
  onEscalated?: (record: EscalationRecord) => void;
  onOpenQuestionEnqueued?: (question: OpenQuestion) => void;
  /** テスト用。未指定時は内部で生成する。 */
  sessionLogger?: SessionLogger;
  /** テスト用。未指定時は内部 AbortController に SIGINT/SIGTERM を結線する。 */
  shutdownSignal?: AbortSignal;
  /** デフォルト true。`shutdownSignal` 未指定時のみ有効。 */
  registerProcessSignalHandlers?: boolean;
  /** GitHub Issue / PR 監視を無効化する。 */
  disableGitHubMonitor?: boolean;
  /** GitHub 更新通知の debounce（ms）。デフォルト 30s。 */
  githubMonitorDebounceMs?: number;
  /** GitHub 監視の通常 poll 間隔（ms）。デフォルト 60s。 */
  githubMonitorPollIntervalMs?: number;
  /** CI pending 時の poll 間隔（ms）。デフォルト 15s。 */
  githubMonitorActivePollIntervalMs?: number;
  /** permission デッドロック検知を無効化する。 */
  disablePermissionDeadlockMonitor?: boolean;
  /** pending permission 継続とみなす閾値（ms）。デフォルト 30s。 */
  permissionDeadlockStallMs?: number;
  /** デッドロック検知の poll 間隔（ms）。デフォルト 5s。 */
  permissionDeadlockPollMs?: number;
}

export interface ConductorSessionResult {
  agentId: string;
  issueUrl: string;
  repoRoot: string;
  /** 完了した `agent.send` 回数。 */
  sendCount: number;
  stopReason: IssueLoopStopReason;
  lastRunStatus: string;
  lastResult?: string;
  lastError?: { message: string; code?: string };
  workerDispatches: WorkerDispatchResult[];
  workerFailures: WorkerFailureRecord[];
  escalations: EscalationRecord[];
  openQuestions: OpenQuestion[];
  /** harness が蓄積した LLM usage サマリ（ラウンド無しのときは省略）。 */
  sessionUsage?: SessionUsageSummary;
}

export async function runConductorSession(
  options: RunConductorSessionOptions,
): Promise<ConductorSessionResult> {
  const ensembleConfig =
    options.ensembleConfig ?? (await loadEnsembleConfig(options.repoRoot));
  const githubAuth = await resolveGitHubAuthToken({ config: ensembleConfig });
  const maxTurns = resolveMaxTurns(options.maxTurns);
  const sessionLogger =
    options.sessionLogger ??
    new SessionLogger({
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
    });
  if (!githubAuth.token) {
    sessionLogger.emit({
      type: 'harness.warning',
      message: GITHUB_AUTH_HINT,
    });
  }
  attachLegacySessionCallbacks(sessionLogger, options);
  const escalations: EscalationRecord[] = [];
  const openQuestions = new OpenQuestionRegistry();
  const eventQueue = new SessionEventQueue();
  let activeProfile = options.profile;
  const workerSessions = new Map<
    string,
    { acpSessionId: string; acpCwd?: string; acpSpawn?: AcpSpawnFingerprint }
  >();
  let githubMonitorCursor: GitHubMonitorCursor | undefined;

  if (options.resumeAgentId) {
    const sidecar = await requireSessionSidecarForResume({
      repoRoot: options.repoRoot,
      conductorAgentId: options.resumeAgentId,
    });
    assertSessionSidecarMatches(sidecar, {
      conductorAgentId: options.resumeAgentId,
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
    });
    openQuestions.restore({
      sequence: sidecar.sequence,
      openQuestions: sidecar.openQuestions,
    });
    activeProfile = sidecar.profile;
    githubMonitorCursor = sidecar.githubMonitor;
    for (const [name, worker] of Object.entries(sidecar.workers)) {
      workerSessions.set(name, {
        acpSessionId: worker.acpSessionId,
        ...(worker.acpCwd ? { acpCwd: worker.acpCwd } : {}),
        ...(worker.acpSpawn ? { acpSpawn: worker.acpSpawn } : {}),
      });
    }
  }

  const ownsShutdownController = !options.shutdownSignal;
  const shutdownController = ownsShutdownController
    ? new AbortController()
    : undefined;
  const shutdownSignal =
    options.shutdownSignal ?? shutdownController!.signal;
  const operatorExitController = new AbortController();
  const driverShutdownSignal = AbortSignal.any([
    shutdownSignal,
    operatorExitController.signal,
  ]);
  let unregisterProcessSignalHandlers = () => {};
  if (
    ownsShutdownController &&
    options.registerProcessSignalHandlers !== false
  ) {
    const onSignal = () => shutdownController!.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    unregisterProcessSignalHandlers = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  }

  const permissionPipeline =
    options.permissionPipeline ??
    new PermissionPipeline({ policy: options.permissionPolicy });

  let scheduleSidecarFlush = () => {};

  const sessionState = sessionStateFromProfile(activeProfile);

  const issue = parseIssueUrl(options.issueUrl);
  const spawnBase: SpawnAcpProcessOptions = {
    onProcessStdioLine: ({ stream, line, workerName }) => {
      if (stream !== 'stderr') return;
      sessionLogger.emit({
        type: 'worker.process.stderr',
        line,
        stream: 'stderr',
        workerName,
      });
    },
  };
  const workers = profileWorkersToSessionSpecs(activeProfile, {
    defaultAcp: options.defaultAcp,
    spawnBase,
  });
  if (workers.length > 0) {
    validateWorkerAcpPrerequisites(
      workers.map((worker) =>
        resolveWorkerAcpSpawn({
          profileAcp: activeProfile.acp,
          workerAcp: activeProfile.workers.find((w) => w.name === worker.name)?.acp,
          defaultOptions: options.defaultAcp,
        }),
      ),
    );
    finalizeSessionWorkerSpecs(workers, activeProfile, options.defaultAcp);
  }
  const workerAcpFingerprints = new Map(
    workers.map((worker) => [worker.name, worker.acpFingerprint] as const),
  );
  const workerWorktree =
    options.workerWorktree ??
    (workers.length > 0
      ? await resolveWorkerWorkspace(
          options.repoRoot,
          issue,
          options.workerWorktreeMode ?? 'isolated',
        )
      : undefined);

  if (workerWorktree) {
    sessionLogger.emit({
      type: 'harness.worktree',
      path: workerWorktree.path,
      branch: workerWorktree.branch,
      mode: options.workerWorktreeMode ?? 'isolated',
    });
  }

  if (workers.length > 0) {
    sessionLogger.emit({
      type: 'harness.session.workers',
      workers: workers.map((worker) => ({
        name: worker.name,
        kind: worker.kind,
      })),
    });
  }

  const sessionUsageTracker = new SessionUsageTracker({
    contextLimitTokens: options.contextLimitTokens,
  });

  const workerSession = new WorkerSession({
    issueUrl: options.issueUrl,
    repoRoot: options.repoRoot,
    ...(workerWorktree ? { worktree: workerWorktree } : {}),
    workers,
    sessionState,
    restoredWorkerSessions: Object.fromEntries(workerSessions),
    permissionPipeline,
    ...(options.connectAcp ? { connectAcp: options.connectAcp } : {}),
    ...(options.ownsWorkerAcpConnections !== undefined
      ? { ownsWorkerAcpConnections: options.ownsWorkerAcpConnections }
      : {}),
    decidePermission: (request, workerId, requestId) => {
      const outcome = permissionPipeline.evaluate(requestId, workerId, request);
      if (outcome.status === 'resolved') {
        return outcome.decision;
      }
      const pending = permissionPipeline.pending.get(requestId);
      if (pending) {
        const workerLabel =
          workerSession.runtime.resolveWorkerLabel(workerId) ?? workerId;
        sessionLogger.emit({
          type: 'permission.pending',
          permission: pending,
          workerLabel,
        });
        eventQueue.enqueue({ type: 'permission.pending', permission: pending });
      }
      return null;
    },
    onWorkerCompleted: (result) => {
      sessionUsageTracker.recordWorkerRound({
        name: result.name,
        kind: result.kind,
        source: result.source,
        prompt: result.prompt,
        promptResult: result.promptResult,
      });
      sessionLogger.emit({ type: 'worker.round', dispatch: result });
      const attached = workerSession.runtime.getAttached(result.name);
      workerSessions.set(result.name, {
        acpSessionId: result.acpSessionId,
        acpCwd: attached?.session.acpCwd ?? workerWorktree?.path,
        ...(workerAcpFingerprints.get(result.name)
          ? { acpSpawn: workerAcpFingerprints.get(result.name) }
          : {}),
      });
      eventQueue.enqueue({ type: 'worker.completed', result });
      scheduleSidecarFlush();
    },
    onWorkerFailed: (failure) => {
      sessionLogger.emit({ type: 'worker.failed', failure });
      eventQueue.enqueue({ type: 'worker.failed', failure });
    },
    onPromptTelemetry: (event) => {
      switch (event.phase) {
        case 'started':
          sessionLogger.emit({
            type: 'harness.worker.prompt.started',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            source: event.source,
          });
          break;
        case 'completed':
          sessionLogger.emit({
            type: 'harness.worker.prompt.completed',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            source: event.source,
            stopReason: event.stopReason!,
          });
          break;
        case 'failed':
          sessionLogger.emit({
            type: 'harness.worker.prompt.failed',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            source: event.source,
            error: event.error!,
          });
          break;
      }
    },
    onAcpUpdate: (event) => {
      sessionLogger.emit({
        type: 'harness.worker.acp.update',
        name: event.name,
        kind: event.kind,
        workerId: event.workerId,
        sessionUpdate: event.sessionUpdate,
        sessionId: event.sessionId,
        ...(event.toolName ? { toolName: event.toolName } : {}),
      });
    },
    onWorkerState: (event) => {
      sessionLogger.emit({
        type: 'harness.worker.state',
        name: event.name,
        kind: event.kind,
        workerId: event.workerId,
        state: event.state,
      });
    },
  });

  workerSession.startWorkers();

  const recordAnsweredQuestion = (answered: OpenQuestion) => {
    const record = openQuestionToEscalationRecord(answered);
    if (record) {
      escalations.push(record);
      sessionLogger.emit({ type: 'escalation.recorded', record });
      options.onEscalated?.(record);
    }
    scheduleSidecarFlush();
  };

  const askHumanTools = createAskHumanTool({
    registry: openQuestions,
    onEnqueued: (question) => {
      sessionLogger.emit({ type: 'open.question.enqueued', question });
      options.onOpenQuestionEnqueued?.(question);
      scheduleSidecarFlush();
    },
  });

  const answerOpenQuestionTools = createAnswerOpenQuestionTool({
    registry: openQuestions,
    onAnswered: recordAnsweredQuestion,
  });

  const openQuestionListTools = createOpenQuestionListTools({
    registry: openQuestions,
  });

  const resolvePermissionTools = createResolvePermissionTool({
    pipeline: permissionPipeline,
    inbox: workerSession.inbox,
  });

  const workerOutboundQueue = new WorkerOutboundQueue((worker, instruction, options) =>
    workerSession.sendWorkerMessage(worker, instruction, options),
  );

  const promptWorkerTools = createPromptWorkerTool({
    outboundQueue: workerOutboundQueue,
    workerNames: activeProfile.workers.map((worker) => worker.name),
  });

  const workerStatusTools = createWorkerStatusTools({
    runtime: workerSession.runtime,
    workerNames: activeProfile.workers.map((worker) => worker.name),
    getWorkerFailures: () => sessionLogger.workerFailures,
  });

  let conductorAgent!: ConductorAgent;

  const sessionUsageTools = createSessionUsageTools({
    tracker: sessionUsageTracker,
    workerNames: activeProfile.workers.map((worker) => worker.name),
    getConductorUsageCost: async () => {
      const usage = await conductorAgent.getUsage();
      return usage.cost;
    },
  });

  const conductorCwd = options.conductorCwd ?? process.cwd();
  const mcpServers = await resolveMcpServersForSdk(options.repoRoot);
  const conductorOptions: ConductorAgentOptions = {
    cwd: conductorCwd,
    apiKey: options.apiKey,
    modelId: options.modelId,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    customTools: {
      ...askHumanTools,
      ...answerOpenQuestionTools,
      ...openQuestionListTools,
      ...resolvePermissionTools,
      ...promptWorkerTools,
      ...workerStatusTools,
      ...sessionUsageTools,
    },
  };

  conductorAgent = options.resumeAgentId
    ? await ConductorAgent.resume(options.resumeAgentId, conductorOptions)
    : await ConductorAgent.create(conductorOptions);
  const conductorHandle: ConductorAgentHandle = { conductor: conductorAgent };
  const sendReconnect = {
    conductorOptions,
    onReconnectAttempt: ({ agentId }: { agentId: string }) => {
      sessionLogger.emit({
        type: 'conductor.auth.reconnect',
        agentId,
      });
    },
  };

  let flushSidecar: () => Promise<void> = async () => {};
  flushSidecar = async (): Promise<void> => {
    const workers: SessionSidecar['workers'] = {};
    for (const [name, worker] of workerSessions) {
      workers[name] = {
        acpSessionId: worker.acpSessionId,
        ...(worker.acpCwd ? { acpCwd: worker.acpCwd } : {}),
        ...(worker.acpSpawn ? { acpSpawn: worker.acpSpawn } : {}),
      };
    }
    const snapshot = openQuestions.snapshot();
    const sidecar: SessionSidecar = {
      version: SESSION_SIDECAR_VERSION,
      conductorAgentId: conductorHandle.conductor.agentId,
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
      profile: structuredClone(activeProfile),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      openQuestions: snapshot.openQuestions,
      sequence: snapshot.sequence,
      workers,
      ...(githubMonitorCursor ? { githubMonitor: githubMonitorCursor } : {}),
      updatedAt: Date.now(),
    };
    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot: options.repoRoot,
        conductorAgentId: conductorHandle.conductor.agentId,
      }),
      sidecar,
    );
  };
  scheduleSidecarFlush = () => {
    void flushSidecar().catch(() => {
      // best-effort persistence
    });
  };

  let sendCount = 0;
  let autonomousTurns = 0;

  let githubMonitor: GitHubMonitor | undefined;
  const monitorDefaults = ensembleConfig.github.monitor;
  if (
    resolveGitHubMonitorEnabled({
      cliDisabled: options.disableGitHubMonitor,
      config: ensembleConfig,
    })
  ) {
    githubMonitor = createGitHubMonitor({
      issueUrl: options.issueUrl,
      ensembleConfig,
      cursor: githubMonitorCursor,
      debounceMs: options.githubMonitorDebounceMs ?? monitorDefaults.debounceMs,
      pollIntervalMs:
        options.githubMonitorPollIntervalMs ?? monitorDefaults.pollIntervalMs,
      activePollIntervalMs:
        options.githubMonitorActivePollIntervalMs ??
        monitorDefaults.activePollIntervalMs,
      stopPollWaitMs: monitorDefaults.stopPollWaitMs,
      shutdownSignal,
      onCursorChange: (cursor) => {
        githubMonitorCursor = cursor;
        scheduleSidecarFlush();
      },
      onUpdate: (payload) => {
        sessionLogger.emit({
          type: 'harness.github.update',
          itemCount: payload.items.length,
        });
        eventQueue.enqueue({
          type: 'github.update',
          items: payload.items,
        });
      },
      onPollError: (error) => {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        if (error instanceof GitHubMonitorError) {
          sessionLogger.emit({
            type: 'harness.github.monitor_error',
            message,
            phase: error.phase,
            prNumber: error.prNumber,
            cause: error.cause,
            retryable: error.retryable,
          });
          return;
        }
        sessionLogger.emit({
          type: 'harness.github.monitor_error',
          message,
        });
      },
    });
    githubMonitor.start();
  }

  let permissionDeadlockMonitor: PermissionDeadlockMonitor | undefined;
  if (!options.disablePermissionDeadlockMonitor) {
    permissionDeadlockMonitor = createPermissionDeadlockMonitor({
      pipeline: permissionPipeline,
      getActivitySnapshot: () => ({
        attachInFlight: workerSession.runtime.attachInFlightCount,
        hasProcessingWorker: workerSession.runtime
          .listWorkerStatuses()
          .some((worker) => worker.state === 'processing'),
      }),
      onWarning: (message) => {
        sessionLogger.emit({ type: 'harness.warning', message });
      },
      stallThresholdMs: options.permissionDeadlockStallMs,
      pollIntervalMs: options.permissionDeadlockPollMs,
      shutdownSignal,
    });
    permissionDeadlockMonitor.start();
  }

  let stopReason: IssueLoopStopReason = 'completed';
  const continueOnConductorError = options.continueOnConductorError ?? false;
  const waitForOperatorExit = options.waitForOperatorExit ?? false;
  let operatorRequestedExit = false;
  let disposeOperatorInput: (() => void) | undefined;

  if (options.bindOperatorInput) {
    const bindingDispose = options.bindOperatorInput({
      submit: (message, submitOptions) => {
        if (isOperatorExitCommand(message)) {
          sessionLogger.emit({ type: 'session.operator_exit' });
          workerSession.runtime.cancelAllActivePrompts();
          operatorRequestedExit = true;
          operatorExitController.abort();
          return false;
        }
        const received = submitOperatorInput({
          message,
          targetOpenQuestionId: submitOptions?.targetOpenQuestionId,
          conductorTurn: sendCount + 1,
          openQuestions,
          escalations,
          eventQueue,
          sessionLogger,
          onEscalated: (record) => options.onEscalated?.(record),
        });
        if (received) {
          scheduleSidecarFlush();
        }
        return received;
      },
      getContext: () => ({
        conductorTurn: sendCount + 1,
        autonomousTurns,
        maxTurns: operatorInputMaxTurns(maxTurns),
        openQuestions: openQuestions.listOpen(),
      }),
    });
    if (typeof bindingDispose === 'function') {
      disposeOperatorInput = bindingDispose;
    }
  }

  try {
    const driverResult = await runConductorSessionDriver({
      issueUrl: options.issueUrl,
      profile: activeProfile,
      ensembleConfig,
      conductorHandle,
      sendReconnect,
      eventQueue,
      workerSession,
      permissionPipeline,
      openQuestions,
      shutdownSignal: driverShutdownSignal,
      maxTurns,
      continueOnConductorError,
      continueAfterIssueLoopStop: waitForOperatorExit,
      onIssueLoopStop: waitForOperatorExit
        ? () => {
            options.onPostLoopWait?.();
            sessionLogger.emit({ type: 'session.post_loop_wait' });
          }
        : undefined,
      workerDispatches: sessionLogger.workerDispatches,
      workerFailures: sessionLogger.workerFailures,
      onSendStarted: (info) => {
        sessionLogger.emit({
          type: 'conductor.send.started',
          sendCount: info.sendCount,
          dispatchSource: info.dispatchSource,
        });
      },
      onSendProgress: (info) => {
        sessionLogger.emit({
          type: 'conductor.send.progress',
          sendCount: info.sendCount,
          runId: info.runId,
          tool: info.tool,
        });
      },
      onSendComplete: recordSendComplete,
      onOpenQuestionEnqueued: (question) => {
        sessionLogger.emit({ type: 'open.question.enqueued', question });
        options.onOpenQuestionEnqueued?.(question);
      },
    });
    stopReason = driverResult.stopReason;
    sendCount = driverResult.sendCount;
    autonomousTurns = driverResult.autonomousTurns;
    if (operatorRequestedExit && stopReason === 'interrupted') {
      stopReason = 'completed';
    }

    return await buildResult();

    function recordSendComplete(info: {
      sendCount: number;
      runId: string;
      status: ConductorSendResult['status'];
      result?: string;
      error?: ConductorSendResult['error'];
      usage?: ConductorSendResult['usage'];
      modelId?: string;
      workerDispatches: number;
      workerFailures: number;
      autonomousTurns: number;
    }): void {
      sendCount = info.sendCount;
      autonomousTurns = info.autonomousTurns;
      sessionUsageTracker.recordConductorRound({
        runId: info.runId,
        status: info.status,
        usage: info.usage,
        modelId: info.modelId,
      });
      sessionLogger.emit({
        type: 'conductor.send',
        sendCount: info.sendCount,
        runId: info.runId,
        status: info.status,
        result: info.result,
        error: info.error,
        workerDispatches: info.workerDispatches,
        workerFailures: info.workerFailures,
      });
      if (
        isConductorSendAuthError({
          runId: info.runId,
          status: info.status,
          error: info.error,
          result: info.result,
        })
      ) {
        sessionLogger.emit({
          type: 'conductor.auth.recovery',
          agentId: conductorHandle.conductor.agentId,
          hint: formatConductorAuthRecoveryHint(conductorHandle.conductor.agentId),
        });
      }
      scheduleSidecarFlush();
    }

    async function buildResult(): Promise<ConductorSessionResult> {
      sessionLogger.finish(stopReason);
      const skipUsageCostFetch =
        operatorRequestedExit || shutdownSignal.aborted;
      const sessionUsage = await enrichSessionUsageWithCost(
        sessionUsageTracker.getSessionSummary(),
        skipUsageCostFetch
          ? undefined
          : async () => {
              const usage = await conductorAgent.getUsage();
              return usage.cost;
            },
      );
      return sessionLogger.snapshot({
        agentId: conductorHandle.conductor.agentId,
        escalations,
        openQuestions: openQuestions.list(),
        sessionUsage:
          sessionUsage.totals.rounds > 0 || sessionUsage.cost != null
            ? sessionUsage
            : undefined,
      });
    }
  } finally {
    const forceShutdown = operatorRequestedExit || shutdownSignal.aborted;
    const teardownStartedAt = Date.now();
    const teardownPhases: Record<string, number> = {};

    unregisterProcessSignalHandlers();

    let teardownSignalCount = 0;
    const onTeardownSignal = () => {
      teardownSignalCount += 1;
      sessionLogger.emit({
        type: 'harness.warning',
        message:
          teardownSignalCount >= 2
            ? '強制終了します…'
            : '終了処理中です。もう一度 Ctrl+C で強制終了できます。',
      });
      if (teardownSignalCount >= 2) {
        process.exit(130);
      }
    };
    process.on('SIGINT', onTeardownSignal);
    process.on('SIGTERM', onTeardownSignal);

    const emitTeardownPhase = (phase: string) => {
      sessionLogger.emit({ type: 'harness.teardown.phase', phase });
    };

    try {
      disposeOperatorInput?.();
      if (permissionDeadlockMonitor) {
        emitTeardownPhase('permissionDeadlockMonitor');
        permissionDeadlockMonitor.stop();
      }
      if (githubMonitor) {
        githubMonitor.flush();
      }
      rejectAllPendingPermissions(permissionPipeline, workerSession.inbox);
      try {
        emitTeardownPhase('flushSidecar');
        const phaseStart = Date.now();
        await flushSidecar();
        teardownPhases.flushSidecar = Date.now() - phaseStart;
      } catch {
        // best-effort persistence
      }

      const runGithubMonitorStop = async (): Promise<void> => {
        if (!githubMonitor) {
          return;
        }
        emitTeardownPhase('githubMonitor');
        const phaseStart = Date.now();
        await githubMonitor.stop();
        githubMonitorCursor = githubMonitor.getCursor();
        teardownPhases.githubMonitor = Date.now() - phaseStart;
      };

      const runWorkerStop = async (): Promise<void> => {
        emitTeardownPhase('workers');
        const phaseStart = Date.now();
        await workerSession.stop({ force: forceShutdown });
        teardownPhases.workers = Date.now() - phaseStart;
      };

      const runConductorClose = async (): Promise<void> => {
        emitTeardownPhase('conductor');
        const phaseStart = Date.now();
        await conductorHandle.conductor.close();
        teardownPhases.conductor = Date.now() - phaseStart;
      };

      if (forceShutdown) {
        await Promise.all([
          runGithubMonitorStop(),
          runWorkerStop(),
          runConductorClose(),
        ]);
      } else {
        await runGithubMonitorStop();
        await runWorkerStop();
        await runConductorClose();
      }

      sessionLogger.emit({
        type: 'harness.teardown',
        force: forceShutdown,
        durationMs: Date.now() - teardownStartedAt,
        phases: teardownPhases,
      });

      if (
        operatorRequestedExit &&
        stopReason !== 'interrupted' &&
        workerWorktree &&
        !workerWorktree.inRepo
      ) {
        emitTeardownPhase('worktree');
        await emitWorktreeRemoval(sessionLogger, options.repoRoot, issue);
      }
    } finally {
      process.off('SIGINT', onTeardownSignal);
      process.off('SIGTERM', onTeardownSignal);
    }
  }
}

async function emitWorktreeRemoval(
  sessionLogger: SessionLogger,
  repoRoot: string,
  issue: IssueRef,
): Promise<void> {
  const result = await removeWorkerWorktree(repoRoot, issue);
  switch (result.status) {
    case 'removed':
      sessionLogger.emit({
        type: 'harness.worktree.removed',
        path: result.path,
        branch: result.branch,
      });
      break;
    case 'skipped_dirty':
      sessionLogger.emit({
        type: 'harness.worktree.remove_skipped',
        path: result.path,
        branch: result.branch,
        reason: 'dirty',
      });
      break;
    case 'failed':
      sessionLogger.emit({
        type: 'harness.worktree.remove_failed',
        path: result.path,
        branch: result.branch,
        error: result.error,
      });
      break;
    case 'not_found':
      break;
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

function attachLegacySessionCallbacks(
  logger: SessionLogger,
  options: RunConductorSessionOptions,
): void {
  if (
    !options.onSendComplete &&
    !options.onWorkerDispatched &&
    !options.onWorkerFailed
  ) {
    return;
  }

  logger.subscribe((event) => {
    switch (event.type) {
      case 'conductor.send':
        options.onSendComplete?.({
          sendCount: event.sendCount,
          runId: event.runId,
          status: event.status as ConductorSendResult['status'],
          result: event.result,
          error: event.error,
          workerDispatches: event.workerDispatches,
          workerFailures: event.workerFailures,
        });
        break;
      case 'worker.round':
        options.onWorkerDispatched?.(event.dispatch);
        break;
      case 'worker.failed':
        options.onWorkerFailed?.(event.failure);
        break;
    }
  });
}

function finalizeSessionWorkerSpecs(
  workers: SessionWorkerSpec[],
  profile: ResolvedProfile,
  defaultAcp?: DefaultAcpResolutionOptions,
): void {
  for (const worker of workers) {
    const profileWorker = profile.workers.find((entry) => entry.name === worker.name);
    const resolved = resolveWorkerAcpSpawn({
      profileAcp: profile.acp,
      workerAcp: profileWorker?.acp,
      defaultOptions: defaultAcp,
    });
    const finalized = finalizeResolvedAcpSpawn(resolved);
    worker.spawn = resolvedAcpSpawnToOptions(finalized, worker.spawn);
    worker.acpFingerprint = acpSpawnFingerprint(finalized);
  }
}
