import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import {
  loadEnsembleConfig,
} from '../config/load-ensemble-config.js';
import type { EnsembleConfig } from '../config/types.js';
import {
  computeMcpConfigDigest,
  resolveMcpServers,
  type LoadMcpConfigOptions,
} from '../mcp/load-mcp-config.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { createOpenQuestionListTools } from '../escalation/open-question-list-tools.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import { deny } from '../permission/permission-broker.js';
import type { PermissionPolicyRules } from '../permission/permission-policy.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import {
  createPermissionDeadlockMonitor,
  type PermissionDeadlockStall,
  type PermissionDeadlockMonitor,
} from '../permission/permission-deadlock-monitor.js';
import { createResolvePermissionTool } from '../permission/resolve-permission-tool.js';
import {
  buildPermissionBrief,
  getPermissionToolCallId,
} from '../permission/permission-brief.js';
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
  resolveAgentPromptModule,
  type SessionWorkerSpec,
} from '../profile/types.js';
import { WorkerSession } from '../runtime/worker-session.js';
import {
  ToolCallSnapshotRegistry,
  type StoredToolCallSnapshot,
} from '../runtime/tool-call-snapshot-registry.js';
import { createPromptWorkerTool } from '../dispatch/prompt-worker-tool.js';
import { createWorkerStatusTools } from '../dispatch/worker-status-tool.js';
import { createGetToolCallTool } from '../dispatch/get-tool-call-tool.js';
import { createSessionUsageTools } from '../dispatch/session-usage-tool.js';
import { createReportSessionStateTool } from '../dispatch/report-session-state-tool.js';
import { createSetDispatchHoldTool } from '../dispatch/set-dispatch-hold-tool.js';
import type { ConnectWorkerAcpFn } from '../dispatch/worker-acp-session.js';
import { parseIssueUrl, type IssueRef } from '../issue/issue-ref.js';
import {
  resolveWorkerWorkspace,
  removeWorkerWorktree,
  type RemoveWorkerWorktreeResult,
  type WorkerWorktreeMode,
  type WorktreeRef,
} from '../worktree/worktree.js';
import { WorkerOutboundQueue } from '../runtime/worker-outbound-queue.js';
import type { WorkerFailureRecord } from '../runtime/types.js';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
} from './conductor-agent.js';
import type { ConductorSendResult } from './conductor-agent.js';
import { ConductorToolRegistry } from './conductor-tool.js';
import { createConductorAgentFactory } from './conductor-agent-factory.js';
import {
  formatConductorAuthRecoveryHint,
  isConductorSendAuthError,
} from './conductor-auth.js';
import { resolvePiConductorProvider } from './conductor-pi-auth.js';
import type { ConductorAgentHandle } from './conductor-send-reconnect.js';
import { SessionLogger } from './session/session-logger.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import {
  bufferDispatchHoldEvents,
  createDispatchHoldState,
  pruneStalePermissionEvents,
  type DispatchHoldChange,
} from './session/dispatch-hold.js';
import {
  operatorInputMaxTurns,
  resolveMaxTurns,
  type IssueLoopStopReason,
} from './session-policy.js';
import { runConductorSessionDriver } from './conductor-session-driver.js';
import { isOperatorExitCommand } from './operator-exit.js';
import { isOperatorCloseCommand } from './operator-close.js';
import { isOperatorReconnectCommand } from './operator-reconnect.js';
import {
  assertSessionSidecarMatches,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarPath,
  type SessionLifecycle,
  type SessionSidecar,
} from '../session/session-sidecar.js';
import {
  saveSessionStatusLine,
  sessionStateStorePath,
} from '../session/session-state-store.js';
import {
  loadToolCallSnapshotHistory,
  pruneExpiredToolCallSnapshotHistoryFiles,
  saveToolCallSnapshotHistory,
  toolCallSnapshotHistoryPath,
} from '../session/tool-call-snapshot-history.js';
import {
  loadOpenQuestionsStore,
  openQuestionsStorePath,
  saveOpenQuestionsStore,
} from '../session/open-questions-store.js';
import {
  OpenQuestionControlOperationError,
  startOpenQuestionControlServer,
  type OpenQuestionControlServer,
} from '../session/open-question-control.js';
import type { SessionUsageSummary } from '../usage/types.js';
import type { PendingPermission } from '../permission/pending-permission.js';
import { formatPermissionSummaryForOperator } from '../permission/format-permission-summary-for-operator.js';
import { enrichSessionUsageWithCost } from '../usage/enrich-session-usage-cost.js';
import { SessionUsageTracker } from '../usage/session-usage-tracker.js';
import type { OperatorInputBinding } from './operator-input-binding.js';
import { submitOperatorInput } from './submit-operator-input.js';
import {
  createGitHubMonitor,
  type GitHubMonitor,
} from '../github/github-monitor.js';
import {
  resolveConductorBackendSetting,
  resolveConductorPiResourcePaths,
  resolveGitHubMonitorEnabled,
} from '../config/resolve-settings.js';
import { GitHubMonitorError } from '../github/github-monitor-error.js';
import {
  formatGitHubErrorMessage,
  GITHUB_AUTH_HINT,
} from '../github/github-auth.js';
import { fetchIssueContext } from '../github/issue-context.js';
import { resolveGitHubAuthToken } from '../github/resolve-github-auth-token.js';
import {
  emptyGitHubMonitorCursor,
  type GitHubMonitorCursor,
} from '../github/github-monitor-cursor.js';
import { createRegisterGitHubWatchTool } from '../github/register-github-watch-tool.js';
import { createUnregisterGitHubWatchTool } from '../github/unregister-github-watch-tool.js';
import { compileConductorSystemPrompt } from '../prompt/compile-system-prompt.js';
import { loadUserInstructions } from '../prompt/load-user-instructions.js';

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
  /** MCP 設定の解決オプション。未指定時は `~/.ensemble` を参照する。 */
  mcpConfigOptions?: LoadMcpConfigOptions;
  /** 作業手順・worker 定義。未指定時は loadProfile でデフォルトを解決する。 */
  profile: ResolvedProfile;
  profilePath?: string;
  resumeAgentId?: string;
  /** Optional factory override. Without it, `conductor.backend` selects the factory. */
  conductorAgentFactory?: ConductorAgentFactory;
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
   * 初回 operator 入力だけで終了する経路。未回答の open question / permission を待たずに停止する。
   * one-shot CLI / env 入力など、追加入力を提供しない View から指定する。
   */
  stopOnUnansweredInput?: boolean;
  /**
   * 自律ループ停止後も harness を維持し、オペレータの `/close` / `/exit` または追加指示を待つ。
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
  /** pending permission 継続とみなす閾値（ms）。デフォルト 300s。 */
  permissionDeadlockStallMs?: number;
  /** デッドロック検知の poll 間隔（ms）。デフォルト 5s。 */
  permissionDeadlockPollMs?: number;
}

export interface ConductorSessionResult {
  agentId: string;
  issueUrl: string;
  repoRoot: string;
  /** SessionLogger 生成時の Unix epoch milliseconds。 */
  startedAt: number;
  /** SessionLogger 生成から終了 snapshot 生成までの経過時間（milliseconds）。 */
  durationMs: number;
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
  const userInstructions = await loadUserInstructions({
    userEnsembleRoot: options.mcpConfigOptions?.userEnsembleRoot,
  });
  const ensembleConfig =
    options.ensembleConfig ?? (await loadEnsembleConfig(options.repoRoot));
  const conductorBackend = resolveConductorBackendSetting({
    profile: options.profile,
    config: ensembleConfig,
  });
  const maxTurns = resolveMaxTurns(options.maxTurns);
  const sessionLogger =
    options.sessionLogger ??
    new SessionLogger({
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
    });
  attachLegacySessionCallbacks(sessionLogger, options);
  const expiredHistory = await pruneExpiredToolCallSnapshotHistoryFiles(
    options.repoRoot,
  );
  if (expiredHistory.failedCount > 0) {
    sessionLogger.emit({
      type: 'harness.warning',
      message:
        'Some expired tool-call snapshot history files could not be removed.',
    });
  }
  const escalations: EscalationRecord[] = [];
  const openQuestions = new OpenQuestionRegistry();
  let harnessSocketPath: string | undefined;
  let openQuestionControlServer: OpenQuestionControlServer | undefined;
  const eventQueue = new SessionEventQueue();
  const dispatchHoldState = createDispatchHoldState();
  const onDispatchHoldChanged = (change: DispatchHoldChange): void => {
    sessionLogger.emit({
      type: 'conductor.dispatch_hold',
      status: change.status,
      hold: change.hold,
      heldEventCount: change.heldEventCount,
      ...(change.flushedEventCount !== undefined
        ? { flushedEventCount: change.flushedEventCount }
        : {}),
    });
  };
  let activeProfile = options.profile;
  let activeLazyWorkers = ensembleConfig.session.lazyWorkers;
  const workerSessions = new Map<
    string,
    { acpSessionId: string; acpCwd?: string; acpSpawn?: AcpSpawnFingerprint }
  >();
  let githubMonitorCursor: GitHubMonitorCursor | undefined;
  let githubMonitor: GitHubMonitor | undefined;
  const pendingGitHubRecoveries: number[] = [];
  const conductorCwd = options.conductorCwd ?? process.cwd();
  const mcpServers = await resolveMcpServers(
    options.repoRoot,
    options.mcpConfigOptions,
  );
  const mcpConfigDigest = computeMcpConfigDigest(mcpServers);
  const mcpConfigConfigured = Object.keys(mcpServers).length > 0;
  let resumeToolCallSnapshots: StoredToolCallSnapshot[] = [];
  let toolCallHistoryNeedsRewrite = false;

  if (options.resumeAgentId) {
    const loadedSidecar = await requireSessionSidecarForResume({
      repoRoot: options.repoRoot,
      conductorAgentId: options.resumeAgentId,
    });
    assertSessionSidecarMatches(loadedSidecar, {
      conductorAgentId: options.resumeAgentId,
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
      conductorBackend,
      mcpConfigDigest,
      mcpConfigConfigured,
    });
    // A previously completed lifecycle no longer describes this instance once
    // resume begins. Persist unknown before restoring or attaching anything so
    // a crash before the first regular sidecar flush cannot leave stale
    // `closed` / `exited` data behind.
    const sidecar: SessionSidecar = {
      ...loadedSidecar,
      lifecycle: 'unknown',
      harnessSocketPath: undefined,
      updatedAt: Date.now(),
    };
    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot: options.repoRoot,
        conductorAgentId: options.resumeAgentId,
      }),
      sidecar,
    );
    const history = await loadToolCallSnapshotHistory({
      repoRoot: options.repoRoot,
      conductorAgentId: options.resumeAgentId,
    });
    resumeToolCallSnapshots = history.entries;
    toolCallHistoryNeedsRewrite = history.needsRewrite;
    if (history.warning) {
      sessionLogger.emit({
        type: 'harness.warning',
        message: `${history.warning}; the session will continue without affected history`,
      });
    }
    const openQuestionsPath = openQuestionsStorePath({
      repoRoot: options.repoRoot,
      conductorAgentId: options.resumeAgentId,
    });
    const openQuestionsSnapshot =
      await loadOpenQuestionsStore(openQuestionsPath);
    if (openQuestionsSnapshot) {
      openQuestions.restore(openQuestionsSnapshot);
    } else {
      const legacySnapshot = {
        sequence: sidecar.sequence,
        openQuestions: sidecar.openQuestions,
      };
      openQuestions.restore(legacySnapshot);
      try {
        await saveOpenQuestionsStore(openQuestionsPath, legacySnapshot);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            `旧 sidecar から復元した open question を YAML にバックフィルできませんでした。今回のセッションは継続します。 error=${detail}`,
        });
      }
    }
    activeProfile = sidecar.profile;
    // Sidecars written before this setting always started every worker eagerly.
    activeLazyWorkers = sidecar.lazyWorkers ?? false;
    githubMonitorCursor = sidecar.githubMonitor;
    for (const [name, worker] of Object.entries(sidecar.workers)) {
      workerSessions.set(name, {
        acpSessionId: worker.acpSessionId,
        ...(worker.acpCwd ? { acpCwd: worker.acpCwd } : {}),
        ...(worker.acpSpawn ? { acpSpawn: worker.acpSpawn } : {}),
      });
    }
  }

  const conductorAgentFactory =
    options.conductorAgentFactory ?? createConductorAgentFactory(conductorBackend);

  const githubAuth = await resolveGitHubAuthToken({ config: ensembleConfig });
  if (!githubAuth.token) {
    sessionLogger.emit({
      type: 'harness.warning',
      message: GITHUB_AUTH_HINT,
    });
  }

  let systemPrompt: string;
  try {
    const issueContext = await fetchIssueContext(options.issueUrl, {
      ensembleConfig,
    });
    systemPrompt = compileConductorSystemPrompt({
      issueUrl: options.issueUrl,
      profile: activeProfile,
      agentModule: resolveAgentPromptModule('conductor', activeProfile.agents),
      issueContext,
      userInstructions,
    });
  } catch (error) {
    throw new Error(formatGitHubErrorMessage(error, ensembleConfig));
  }

  const ownsShutdownController = !options.shutdownSignal;
  const shutdownController = ownsShutdownController
    ? new AbortController()
    : undefined;
  const shutdownSignal =
    options.shutdownSignal ?? shutdownController!.signal;
  const operatorTerminationController = new AbortController();
  const driverShutdownSignal = AbortSignal.any([
    shutdownSignal,
    operatorTerminationController.signal,
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
  let flushSidecar: (lifecycle?: SessionLifecycle) => Promise<void> =
    async () => {};
  let scheduleToolCallHistoryFlush = () => {};
  let flushToolCallHistory = async () => {};
  let toolCallHistoryDirty = toolCallHistoryNeedsRewrite;

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
          defaultOptions: options.defaultAcp,
        }),
      ),
    );
    finalizeSessionWorkerSpecs(workers, options.defaultAcp);
  }
  const workerAcpFingerprints = new Map(
    workers.map((worker) => [worker.name, worker.acpFingerprint] as const),
  );
  let teardownStarted = false;
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
      ...(activeLazyWorkers ? { initialState: 'sleeping' } : {}),
    });
  }

  const sessionUsageTracker = new SessionUsageTracker({
    contextLimitTokens: options.contextLimitTokens,
    trackCompactions:
      conductorBackend === 'pi' && options.conductorAgentFactory == null,
  });

  const toolCallSnapshots = new ToolCallSnapshotRegistry();
  let toolCallHistoryLimitWarningEmitted = false;
  let toolCallHistoryOversizeWarningEmitted = false;

  const workerSession = new WorkerSession({
    issueUrl: options.issueUrl,
    repoRoot: options.repoRoot,
    ...(workerWorktree ? { worktree: workerWorktree } : {}),
    workers,
    lazyWorkers: activeLazyWorkers,
    sessionState,
    restoredWorkerSessions: Object.fromEntries(workerSessions),
    permissionPipeline,
    ...(options.connectAcp ? { connectAcp: options.connectAcp } : {}),
    ...(options.ownsWorkerAcpConnections !== undefined
      ? { ownsWorkerAcpConnections: options.ownsWorkerAcpConnections }
      : {}),
    decidePermission: (request, workerId, requestId) => {
      if (teardownStarted) {
        const workerLabel =
          workerSession.runtime.resolveWorkerLabel(workerId) ?? workerId;
        sessionLogger.emit({
          type: 'harness.warning',
          message: `permission.rejected reason=teardown worker=${workerLabel} tool=${request.toolName} id=${requestId}`,
        });
        return deny(request);
      }
      const outcome = permissionPipeline.evaluate(requestId, workerId, request);
      if (outcome.status === 'resolved') {
        return outcome.decision;
      }
      const pending = permissionPipeline.pending.get(requestId);
      if (pending) {
        const workerLabel =
          workerSession.runtime.resolveWorkerLabel(workerId) ?? workerId;
        const operatorSummary = formatPermissionSummaryForOperator(pending, {
          workerLabel,
        });
        const toolCallId = getPermissionToolCallId(pending.request);
        const toolCallSnapshot =
          toolCallId && pending.request.sessionId
            ? toolCallSnapshots.get(toolCallId, {
                workerId,
                sessionId: pending.request.sessionId,
              })
            : undefined;
        sessionLogger.emit({
          type: 'permission.pending',
          permission: pending,
          workerLabel,
        });
        eventQueue.enqueue({
          type: 'permission.pending',
          permission: pending,
          worker: workerLabel,
          brief: buildPermissionBrief(
            pending.request,
            toolCallSnapshot,
          ),
          operatorSummary,
        });
      }
      return null;
    },
    onPermissionCleanup: ({ workerId, entries }) => {
      sessionLogger.emit({
        type: 'permission.cleanup',
        reason: 'worker.failed',
        workerId,
        entries: entries.map(({ id, workerId: entryWorkerId }) => ({
          id,
          workerId: entryWorkerId,
        })),
      });
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
      if (event.toolCallUpdate) {
        const result = toolCallSnapshots.applyWithResult(
          {
            workerId: event.workerId,
            workerName: event.name,
            sessionId: event.sessionId ?? '',
          },
          event.toolCallUpdate,
        );
        if (result.status === 'applied') {
          toolCallHistoryDirty = true;
          scheduleToolCallHistoryFlush();
          if (
            result.evictedCount > 0 &&
            !toolCallHistoryLimitWarningEmitted
          ) {
            toolCallHistoryLimitWarningEmitted = true;
            sessionLogger.emit({
              type: 'harness.warning',
              message:
                'Tool-call snapshot history reached its retention limit; oldest snapshots were removed.',
            });
          }
        } else if (result.reason === 'too-large') {
          toolCallHistoryDirty = true;
          scheduleToolCallHistoryFlush();
          if (!toolCallHistoryOversizeWarningEmitted) {
            toolCallHistoryOversizeWarningEmitted = true;
            sessionLogger.emit({
              type: 'harness.warning',
              message:
                'A tool-call snapshot exceeds the history size limit and was not retained.',
            });
          }
        }
      }
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
      if (activeLazyWorkers && event.state === 'attaching') {
        sessionLogger.emit({
          type: 'harness.worker.bootstrap',
          workers: [{ name: event.name, kind: event.kind }],
          mode: 'init',
        });
      }
      sessionLogger.emit({
        type: 'harness.worker.state',
        name: event.name,
        kind: event.kind,
        workerId: event.workerId,
        state: event.state,
      });
    },
  });

  if (workers.length > 0 && !activeLazyWorkers) {
    sessionLogger.emit({
      type: 'harness.worker.bootstrap',
      workers: workers.map((worker) => ({
        name: worker.name,
        kind: worker.kind,
      })),
      mode: 'init',
    });
  }
  workerSession.startWorkers();
  if (resumeToolCallSnapshots.length > 0) {
    const workerIdsByName = new Map<string, string>();
    workers.forEach((worker, index) => {
      const workerId = workerSession.startedWorkerIds[index];
      if (workerId) workerIdsByName.set(worker.name, workerId);
    });
    const restoreResult = toolCallSnapshots.restore(
      resumeToolCallSnapshots,
      workerIdsByName,
    );
    if (restoreResult.skippedCount > 0) {
      toolCallHistoryDirty = true;
      sessionLogger.emit({
        type: 'harness.warning',
        message: `${restoreResult.skippedCount} tool-call snapshot entr${restoreResult.skippedCount === 1 ? 'y was' : 'ies were'} skipped because its worker is no longer available or its data is invalid.`,
      });
    }
  }

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
  const getToolCallTools = createGetToolCallTool({
    snapshots: toolCallSnapshots,
  });

  let outboundDispatchesThisSend = 0;
  const outboundWorkersThisSend = new Set<string>();
  const workerOutboundQueue = new WorkerOutboundQueue((worker, instruction, options) => {
    const result = workerSession.sendWorkerMessage(worker, instruction, options);
    if (result.status !== 'error') {
      outboundDispatchesThisSend += 1;
      outboundWorkersThisSend.add(worker);
    }
    return result;
  });

  const promptWorkerTools = createPromptWorkerTool({
    outboundQueue: workerOutboundQueue,
    workerNames: activeProfile.workers.map((worker) => worker.name),
  });

  const workerStatusTools = createWorkerStatusTools({
    runtime: workerSession.runtime,
    workerNames: activeProfile.workers.map((worker) => worker.name),
    getWorkerFailures: () => sessionLogger.workerFailures,
  });

  const registerGitHubWatchTools = createRegisterGitHubWatchTool({
    issueUrl: options.issueUrl,
    getCursor: () => {
      githubMonitorCursor ??= emptyGitHubMonitorCursor();
      return githubMonitorCursor;
    },
    onRegistered: async (registration) => {
      githubMonitor?.registerPullRequest?.(registration);
      // Do not report success to the conductor until the explicit watch is
      // durable. This closes the crash window between the tool result and a
      // later best-effort flush.
      await flushSidecar();
    },
  });
  const unregisterGitHubWatchTools = createUnregisterGitHubWatchTool({
    issueUrl: options.issueUrl,
    getCursor: () => {
      githubMonitorCursor ??= emptyGitHubMonitorCursor();
      return githubMonitorCursor;
    },
    onUnregistered: async (prNumber) => {
      githubMonitor?.unregisterPullRequest?.(prNumber);
      await flushSidecar();
    },
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

  let sessionStateWriteQueue: Promise<void> = Promise.resolve();
  const reportSessionStateTool = createReportSessionStateTool({
    onReport: (statusLine) => {
      if (teardownStarted) {
        throw new Error('report_session_state is unavailable during teardown');
      }
      const write = sessionStateWriteQueue.then(() =>
        saveSessionStatusLine(
          sessionStateStorePath({
            repoRoot: options.repoRoot,
            conductorAgentId: conductorAgent.agentId,
          }),
          statusLine,
        ),
      );
      sessionStateWriteQueue = write.catch(() => {});
      return write;
    },
  });

  const dispatchHoldTools = createSetDispatchHoldTool({
    state: dispatchHoldState,
    onChanged: onDispatchHoldChanged,
    onBeforeRelease: () => {
      bufferDispatchHoldEvents({
        state: dispatchHoldState,
        eventQueue,
        onChanged: onDispatchHoldChanged,
      });
      pruneStalePermissionEvents({
        state: dispatchHoldState,
        eventQueue,
        isPermissionPending: (requestId) =>
          permissionPipeline.pending.get(requestId) !== undefined,
        onChanged: onDispatchHoldChanged,
      });
    },
  });

  const conductorToolRegistry = new ConductorToolRegistry();
  conductorToolRegistry
    .registerAll(askHumanTools)
    .registerAll(answerOpenQuestionTools)
    .registerAll(openQuestionListTools)
    .registerAll(resolvePermissionTools)
    .registerAll(getToolCallTools)
    .registerAll(promptWorkerTools)
    .registerAll(workerStatusTools)
    .registerAll(registerGitHubWatchTools)
    .registerAll(unregisterGitHubWatchTools)
    .registerAll(sessionUsageTools)
    .registerAll(reportSessionStateTool)
    .registerAll(dispatchHoldTools);

  const conductorOptions: ConductorAgentCreateOptions = {
    cwd: conductorCwd,
    systemPrompt,
    builtinTools: activeProfile.conductor?.builtinTools !== false,
    ...(conductorBackend === 'pi'
      ? { piSkills: activeProfile.conductor?.piSkills !== false }
      : {}),
    apiKey: options.apiKey,
    modelId: options.modelId,
    ...(conductorBackend === 'pi'
      ? {
          pi: resolveConductorPiResourcePaths({
            repoRoot: options.repoRoot,
            config: ensembleConfig,
          }),
        }
      : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    customTools: conductorToolRegistry.toRecord(),
    ...(conductorBackend === 'pi' && options.conductorAgentFactory == null
      ? {
          onContextCompaction: () =>
            sessionUsageTracker.recordContextCompaction(),
        }
      : {}),
  };

  const conductorProvider =
    conductorBackend === 'pi'
      ? (await resolvePiConductorProvider({
          cwd: conductorOptions.cwd,
          modelId: conductorOptions.modelId,
          pi: conductorOptions.pi,
        })) || undefined
      : undefined;

  conductorAgent = options.resumeAgentId
    ? await conductorAgentFactory.resume(options.resumeAgentId, conductorOptions)
    : await conductorAgentFactory.create(conductorOptions);
  const conductorHandle: ConductorAgentHandle = { conductor: conductorAgent };
  // Keep auth/transport reconnects on the same backend factory as the session.
  const sendReconnect = {
    conductorAgentFactory,
    conductorOptions,
    onAuthReconnectAttempt: ({ agentId }: { agentId: string }) => {
      sessionLogger.emit({
        type: 'conductor.auth.reconnect',
        agentId,
      });
    },
    onTransportReconnectAttempt: ({ agentId }: { agentId: string }) => {
      sessionLogger.emit({
        type: 'conductor.transport.reconnect',
        agentId,
        status: 'attempt',
      });
    },
    onTransportReconnectComplete: ({
      agentId,
      success,
      error,
    }: {
      agentId: string;
      success: boolean;
      error?: string;
    }) => {
      sessionLogger.emit({
        type: 'conductor.transport.reconnect',
        agentId,
        status: success ? 'succeeded' : 'failed',
        ...(error ? { error } : {}),
      });
    },
  };

  let sidecarFlushQueue: Promise<void> = Promise.resolve();
  flushSidecar = (lifecycle): Promise<void> => {
    const nextFlush = sidecarFlushQueue.then(async () => {
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
        conductorBackend,
        lazyWorkers: activeLazyWorkers,
        ...(harnessSocketPath ? { harnessSocketPath } : {}),
        issueUrl: options.issueUrl,
        repoRoot: options.repoRoot,
        profile: structuredClone(activeProfile),
        ...(options.profilePath ? { profilePath: options.profilePath } : {}),
        openQuestions: snapshot.openQuestions,
        sequence: snapshot.sequence,
        workers,
        mcpConfigDigest,
        ...(lifecycle ? { lifecycle } : {}),
        ...(githubMonitorCursor ? { githubMonitor: githubMonitorCursor } : {}),
        updatedAt: Date.now(),
      };
      await saveOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot: options.repoRoot,
          conductorAgentId: conductorHandle.conductor.agentId,
        }),
        snapshot,
      );
      await saveSessionSidecar(
        sessionSidecarPath({
          repoRoot: options.repoRoot,
          conductorAgentId: conductorHandle.conductor.agentId,
        }),
        sidecar,
      );
    });
    sidecarFlushQueue = nextFlush.catch(() => {});
    return nextFlush;
  };
  const reportSidecarFlushFailure = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    sessionLogger.emit({
      type: 'harness.warning',
      message:
        `Open Question YAML / session sidecar を保存できませんでした。最新状態から再開できず、直前に保存された状態からの再開になる場合があります。 error=${detail}`,
    });
  };
  scheduleSidecarFlush = () => {
    void flushSidecar().catch(reportSidecarFlushFailure);
  };
  const toolCallHistoryPath = toolCallSnapshotHistoryPath({
    repoRoot: options.repoRoot,
    conductorAgentId: conductorHandle.conductor.agentId,
  });
  let toolCallHistoryFlushTimer:
    | ReturnType<typeof setTimeout>
    | undefined;
  let toolCallHistoryFlushQueue: Promise<void> = Promise.resolve();
  let toolCallHistoryFlushWarningEmitted = false;
  const emitToolCallHistoryFlushWarning = () => {
    if (toolCallHistoryFlushWarningEmitted) return;
    toolCallHistoryFlushWarningEmitted = true;
    sessionLogger.emit({
      type: 'harness.warning',
      message:
        'Tool-call snapshot history could not be saved; the latest history may be unavailable after resume.',
    });
  };
  flushToolCallHistory = (): Promise<void> => {
    if (toolCallHistoryFlushTimer) {
      clearTimeout(toolCallHistoryFlushTimer);
      toolCallHistoryFlushTimer = undefined;
    }
    if (!toolCallHistoryDirty) return toolCallHistoryFlushQueue;

    toolCallHistoryDirty = false;
    const nextFlush = toolCallHistoryFlushQueue.then(() =>
      saveToolCallSnapshotHistory(toolCallHistoryPath, toolCallSnapshots.snapshot()),
    );
    toolCallHistoryFlushQueue = nextFlush.catch(() => {});
    return nextFlush;
  };
  scheduleToolCallHistoryFlush = () => {
    toolCallHistoryDirty = true;
    if (toolCallHistoryFlushTimer) return;
    toolCallHistoryFlushTimer = setTimeout(() => {
      toolCallHistoryFlushTimer = undefined;
      void flushToolCallHistory().catch(() => {
        toolCallHistoryDirty = true;
        emitToolCallHistoryFlushWarning();
      });
    }, 100);
    toolCallHistoryFlushTimer.unref?.();
  };
  const flushToolCallHistoryBestEffort = async (): Promise<void> => {
    try {
      await flushToolCallHistory();
    } catch {
      toolCallHistoryDirty = true;
      emitToolCallHistoryFlushWarning();
    }
  };
  if (toolCallHistoryDirty) scheduleToolCallHistoryFlush();

  let sendCount = 0;
  let autonomousTurns = 0;

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
        for (const suppressedErrorCount of pendingGitHubRecoveries.splice(0)) {
          eventQueue.enqueue({
            type: 'harness.connectivity.recovered',
            source: 'github_monitor',
            suppressedErrorCount,
            dispatchMode: 'inform',
          });
        }
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
      onPollRecovered: (suppressedErrorCount, hasUpdates) => {
        sessionLogger.emit({
          type: 'harness.github.monitor_recovered',
          suppressedErrorCount,
        });
        if (hasUpdates) {
          pendingGitHubRecoveries.push(suppressedErrorCount);
        } else {
          eventQueue.enqueue({
            type: 'harness.connectivity.recovered',
            source: 'github_monitor',
            suppressedErrorCount,
          });
        }
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
      onStall: (stall: PermissionDeadlockStall) => {
        eventQueue.enqueue({
          type: 'permission.stall',
          message: stall.message,
          pendingPermissionIds: stall.pendingPermissionIds,
          pendingPermissionCount: stall.pendingPermissionCount,
          oldestPermissionCreatedAt: stall.oldestPermissionCreatedAt,
          stallAgeMs: stall.stallAgeMs,
          stallThresholdMs: stall.stallThresholdMs,
        });
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
  let operatorRequestedClose = false;
  let disposeOperatorInput: (() => void) | undefined;

  if (options.bindOperatorInput) {
    const bindingDispose = options.bindOperatorInput({
      submit: (message, submitOptions) => {
        if (isOperatorExitCommand(message)) {
          sessionLogger.emit({ type: 'session.operator_exit' });
          workerSession.runtime.cancelAllActivePrompts();
          operatorRequestedExit = true;
          operatorTerminationController.abort();
          return false;
        }
        if (isOperatorCloseCommand(message)) {
          sessionLogger.emit({ type: 'session.operator_close' });
          workerSession.runtime.cancelAllActivePrompts();
          operatorRequestedClose = true;
          operatorTerminationController.abort();
          return false;
        }
        if (isOperatorReconnectCommand(message)) {
          eventQueue.enqueue({ type: 'operator.reconnect' });
          return true;
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
    openQuestionControlServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => openQuestions.listOpen(),
      answerOpenQuestion: async ({ questionId, answer }) => {
        if (teardownStarted) {
          throw new OpenQuestionControlOperationError(
            -32000,
            'The session is shutting down.',
          );
        }
        const current = openQuestions.get(questionId);
        if (!current || current.status !== 'open') {
          throw new OpenQuestionControlOperationError(
            -32004,
            'Open Question is not available.',
          );
        }
        const accepted = submitOperatorInput({
          message: answer,
          targetOpenQuestionId: questionId,
          conductorTurn: sendCount + 1,
          openQuestions,
          escalations,
          eventQueue,
          sessionLogger,
          onEscalated: (record) => options.onEscalated?.(record),
        });
        const answered = openQuestions.get(questionId);
        if (!accepted || !answered || answered.status !== 'answered') {
          throw new OpenQuestionControlOperationError(
            -32004,
            'Open Question could not be answered.',
          );
        }
        await flushSidecar();
        return answered;
      },
    });
    harnessSocketPath = openQuestionControlServer.socketPath;
    await flushSidecar().catch(reportSidecarFlushFailure);

    const driverResult = await runConductorSessionDriver({
      issueUrl: options.issueUrl,
      initialPrompt:
        conductorBackend === 'pi'
          ? createPiKickoffPrompt(options.issueUrl)
          : systemPrompt,
      conductorHandle,
      sendReconnect,
      eventQueue,
      dispatchHoldState,
      onDispatchHoldChanged,
      resetOutboundDispatchesThisSend: () => {
        outboundDispatchesThisSend = 0;
        outboundWorkersThisSend.clear();
      },
      getOutboundDispatchesThisSend: () => outboundDispatchesThisSend,
      workerSession,
      permissionPipeline,
      isPermissionPending: (requestId) =>
        permissionPipeline.pending.get(requestId) !== undefined,
      openQuestions,
      shutdownSignal: driverShutdownSignal,
      maxTurns,
      continueOnConductorError,
      stopOnUnansweredInput: options.stopOnUnansweredInput,
      continueAfterIssueLoopStop: waitForOperatorExit,
      onIssueLoopStop: waitForOperatorExit
        ? () => {
            options.onPostLoopWait?.();
            sessionLogger.emit({ type: 'session.post_loop_wait' });
          }
        : undefined,
      workerDispatches: sessionLogger.workerDispatches,
      workerFailures: sessionLogger.workerFailures,
      onConductorInbound: (info) => {
        sessionLogger.emit({
          type: 'conductor.inbound',
          triggers: info.triggers,
          sources: info.sources,
        });
      },
      // Agent.resume already retains the conductor conversation. Worker
      // startup happens before the driver, so resume events (including
      // permission.pending) must be dispatched without waiting for a new
      // session briefing.
      skipInitialSend: Boolean(options.resumeAgentId),
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
    if (
      (operatorRequestedExit || operatorRequestedClose) &&
      stopReason === 'interrupted'
    ) {
      stopReason = 'completed';
    }

    return await buildResult();

    function recordSendComplete(info: {
      sendCount: number;
      runId: string;
      status: ConductorSendResult['status'];
      githubUpdateIds?: string[];
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
      const githubUpdateIds = info.githubUpdateIds ?? [];
      if (
        info.status === 'finished' &&
        !operatorRequestedClose &&
        githubUpdateIds.length > 0
      ) {
        githubMonitor?.acknowledgeUpdates?.(githubUpdateIds);
      }
      sessionUsageTracker.recordConductorRound({
        runId: info.runId,
        status: info.status,
        usage: info.usage,
        modelId: info.modelId,
      });
      if (outboundWorkersThisSend.size > 0) {
        sessionLogger.emit({
          type: 'conductor.outbound',
          workers: [...outboundWorkersThisSend],
          mode: 'conductor',
        });
      }
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
      outboundWorkersThisSend.clear();
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
          hint: formatConductorAuthRecoveryHint(
            conductorHandle.conductor.agentId,
            conductorBackend === 'pi'
              ? {
                  backend: 'pi',
                  pi: { agentDir: conductorOptions.pi?.agentDir },
                  provider: conductorProvider,
                }
              : { backend: 'cursor' },
          ),
        });
      }
      scheduleSidecarFlush();
    }

    async function buildResult(): Promise<ConductorSessionResult> {
      sessionLogger.finish(stopReason);
      const skipUsageCostFetch =
        operatorRequestedExit ||
        operatorRequestedClose ||
        shutdownSignal.aborted;
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
          sessionUsage.totals.rounds > 0 ||
          sessionUsage.cost != null ||
          sessionUsage.compactionCount != null
            ? sessionUsage
            : undefined,
      });
    }
  } finally {
    teardownStarted = true;
    const forceShutdown =
      operatorRequestedExit ||
      operatorRequestedClose ||
      shutdownSignal.aborted;
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
      const activeControlServer = openQuestionControlServer;
      openQuestionControlServer = undefined;
      harnessSocketPath = undefined;
      if (activeControlServer) {
        emitTeardownPhase('openQuestionControl');
        const phaseStart = Date.now();
        try {
          await activeControlServer.close();
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          sessionLogger.emit({
            type: 'harness.warning',
            message: `Open Question control socket cleanup failed: ${detail}`,
          });
        }
        teardownPhases.openQuestionControl = Date.now() - phaseStart;
      }
      disposeOperatorInput?.();
      if (permissionDeadlockMonitor) {
        emitTeardownPhase('permissionDeadlockMonitor');
        permissionDeadlockMonitor.stop();
      }
      if (githubMonitor && !operatorRequestedClose) {
        githubMonitor.flush();
      }
      // Stop active prompts before closing ACP bridges. Requests that arrive
      // after this point are rejected by the teardown guard above.
      workerSession.runtime.cancelAllActivePrompts();
      if (operatorRequestedClose) {
        // A worker's ACP session exists before its first prompt completes, but
        // workerSessions is normally updated by onWorkerCompleted. Snapshot
        // attached sessions now so force shutdown cannot discard the only
        // completion event that would have persisted a resumable session ID.
        for (const attached of workerSession.runtime.listAttached()) {
          workerSessions.set(attached.name, {
            acpSessionId: attached.session.sessionId,
            acpCwd: attached.session.acpCwd,
            ...(workerAcpFingerprints.get(attached.name)
              ? { acpSpawn: workerAcpFingerprints.get(attached.name) }
              : {}),
          });
        }
      }
      const rejectedPendingPermissions = rejectAllPendingPermissions(
        permissionPipeline,
        workerSession.inbox,
      );
      if (rejectedPendingPermissions.length > 0) {
        sessionLogger.emit({
          type: 'permission.cleanup',
          reason: 'teardown',
          entries: rejectedPendingPermissions.map(({ id, workerId }) => ({
            id,
            workerId,
          })),
        });
      }

      let githubMonitorStopped = false;
      if (githubMonitor && operatorRequestedClose) {
        emitTeardownPhase('githubMonitor');
        const phaseStart = Date.now();
        await githubMonitor.stop();
        githubMonitorCursor = githubMonitor.getCursor();
        teardownPhases.githubMonitor = Date.now() - phaseStart;
        githubMonitorStopped = true;
      }

      try {
        emitTeardownPhase('flushSidecar');
        const phaseStart = Date.now();
        await flushSidecar();
        teardownPhases.flushSidecar = Date.now() - phaseStart;
      } catch (error) {
        reportSidecarFlushFailure(error);
      }
      await flushToolCallHistoryBestEffort();

      const runGithubMonitorStop = async (): Promise<void> => {
        if (!githubMonitor || githubMonitorStopped) {
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
        if (operatorRequestedClose && conductorHandle.conductor.closeForResume) {
          await conductorHandle.conductor.closeForResume();
        } else {
          await conductorHandle.conductor.close();
        }
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
        // A monitor stop callback can synchronously dispatch a worker prompt.
        // Cancel that prompt before WorkerRuntime waits for idle and closes
        // the ACP bridge.
        workerSession.runtime.cancelAllActivePrompts();
        await runWorkerStop();
        await runConductorClose();
      }

      // ACP updates can arrive while cancellation and bridge shutdown settle.
      // Flush once more after all workers stop to capture their final snapshot.
      await flushToolCallHistoryBestEffort();

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
        await emitWorktreeRemoval(sessionLogger, options.repoRoot, workerWorktree);
      }
    } finally {
      const lifecycle: SessionLifecycle = operatorRequestedClose
        ? 'closed'
        : operatorRequestedExit
          ? 'exited'
          : shutdownSignal.aborted
            ? 'interrupted'
            : 'unknown';
      try {
        emitTeardownPhase('flushSidecar');
        await sessionStateWriteQueue;
        await flushSidecar(lifecycle);
      } catch (error) {
        reportSidecarFlushFailure(error);
      }
      process.off('SIGINT', onTeardownSignal);
      process.off('SIGTERM', onTeardownSignal);
    }
  }
}

function createPiKickoffPrompt(issueUrl: string): string {
  return (
    `Start the conductor workflow for ${issueUrl}. ` +
    'Review the Issue context in your system instructions and dispatch the first required worker with prompt_worker.'
  );
}

async function emitWorktreeRemoval(
  sessionLogger: SessionLogger,
  repoRoot: string,
  worktree: WorktreeRef,
): Promise<void> {
  let result: RemoveWorkerWorktreeResult;
  try {
    result = await removeWorkerWorktree(repoRoot, worktree.issue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    sessionLogger.emit({
      type: 'harness.worktree.remove_failed',
      path: worktree.path,
      branch: worktree.branch,
      error: `cleanup threw unexpectedly: ${detail}`,
    });
    return;
  }

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
): PendingPermission[] {
  const rejected: PendingPermission[] = [];
  for (const pending of [...pipeline.pending.list()]) {
    try {
      rejected.push(pipeline.resolveAndFulfill(inbox, pending.id, false));
    } catch {
      // already resolved
    }
  }
  return rejected;
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
  defaultAcp?: DefaultAcpResolutionOptions,
): void {
  for (const worker of workers) {
    const resolved = resolveWorkerAcpSpawn({
      defaultOptions: defaultAcp,
    });
    const finalized = finalizeResolvedAcpSpawn(resolved);
    worker.spawn = resolvedAcpSpawnToOptions(finalized, worker.spawn);
    worker.acpFingerprint = acpSpawnFingerprint(finalized);
  }
}
