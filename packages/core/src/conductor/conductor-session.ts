import { WORKSPACE_WORKER_PROMPT_VERSION } from '../workspace-run/worker-prompt-version.js';
import { conductorFailureLogPath, createConductorFailureLog } from '../session/conductor-failure-log.js';
import { SessionOwnership, type SessionWriteLease } from '../session/session-ownership.js';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';
import { acquireSessionMigrationReadLock, acquireSessionOwnerLock } from '../session/session-owner-lock.js';
import { readWorkspaceAnchor } from '../workspace-run/slug-key.js';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import {
  computeAcpModelConfigDigest,
  computeEnsembleConfigDigest,
  computeResumeFeasibilityConfigDigest,
} from '../config/ensemble-config-digest.js';
import { loadEnsembleConfig } from '../config/load-ensemble-config.js';
import type { EnsembleConfig } from '../config/types.js';
import {
  computeMcpConfigDigest,
  resolveConductorMcpServers,
  type LoadMcpConfigOptions,
} from '../mcp/load-mcp-config.js';
import { createAnswerOpenQuestionTool } from '../escalation/answer-open-question-tool.js';
import { createAskHumanTool } from '../escalation/ask-human-tool.js';
import { createOpenQuestionListTools } from '../escalation/open-question-list-tools.js';
import { openQuestionToEscalationRecord } from '../escalation/open-question-to-escalation.js';
import type { OpenQuestion } from '../escalation/open-question.js';
import {
  OpenQuestionRegistry,
  type OpenQuestionRegistrySnapshot,
} from '../escalation/open-question.js';
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
  isBuiltinAcpPresetId,
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from '../acp/resolve-acp-spawn.js';
import { configurePiWorkerRuntime } from '../acp/pi-runtime.js';
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
import { isConductorAgentFactoryCleanupIncomplete } from './conductor-agent-factory-cleanup.js';
import { ConductorToolRegistry } from './conductor-tool.js';
import { createConductorAgentFactory } from './conductor-agent-factory.js';
import { resolveConductorReasoning } from './resolve-conductor-reasoning.js';
import {
  formatConductorAuthRecoveryHint,
  isConductorSendAuthError,
} from './conductor-auth.js';
import { resolvePiConductorProvider } from './conductor-pi-auth.js';
import { closeConductorAgentOnce } from './conductor-send-reconnect.js';
import type { ConductorAgentHandle } from './conductor-send-reconnect.js';
import { escapeTerminalControlCharacters } from '../representation/escape-terminal-control-characters.js';
import { cursorBootstrapCompleteForStore } from './cursor-bootstrap-state.js';
import type {
  CursorBootstrapAssumption,
  CursorBootstrapState,
} from './cursor-bootstrap-state.js';
import { SessionLogger } from './session/session-logger.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import type {
  OperatorMessageDelivery,
  OperatorMessageEvent,
  SessionEvent,
} from './session/session-event.js';
import {
  bufferDispatchHoldEvents,
  createDispatchHoldState,
  pruneStalePermissionEvents,
  type DispatchHoldChange,
} from './session/dispatch-hold.js';
import {
  createDispatchHoldReminderMonitor,
  formatDispatchHoldReminderMessage,
  type DispatchHoldReminderMonitor,
} from './session/dispatch-hold-reminder-monitor.js';
import {
  operatorInputMaxTurns,
  resolveMaxTurns,
  type IssueLoopStopReason,
} from './session-policy.js';
import {
  runConductorSessionDriver,
  type ConductorDispatchPayload,
} from './conductor-session-driver.js';
import { isOperatorExitCommand } from './operator-exit.js';
import { isOperatorCloseCommand } from './operator-close.js';
import { isOperatorReconnectCommand } from './operator-reconnect.js';
import { parseOperatorMessageDelivery } from './operator-command.js';
import {
  assertSessionResumeStoreMatches,
  canonicalSessionResumeStorePath,
  requireLocatedSessionResumeStoreForResume,
  saveSessionResumeStore,
  SESSION_RESUME_STORE_VERSION,
  WORKSPACE_RENAME_SESSION_RESUME_STORE_VERSION,
  type HarnessPhase,
  type SessionLifecycle,
  type EnsembleConfigDigestScheme,
  type SessionResumeStore,
  type WorkerSessionResumeStore,
  type LocatedSessionResumeStore,
} from '../session/session-resume-store.js';
import {
  buildSessionModelsSummary,
  type SessionModelsSummary,
} from '../session/build-session-models-summary.js';
import {
  saveSessionStatusLine,
  sessionStateStorePath,
  loadSessionStateStore,
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
import { sessionSnapshotPaths } from '../session/session-snapshot-paths.js';
import { classifySessionWorkStatus } from '../session/session-work-status.js';
import {
  CONDUCTOR_MESSAGE_HISTORY_MAX_ENTRIES,
  OpenQuestionControlOperationError,
  startOpenQuestionControlServer,
  type OpenQuestionControlConductorMessage,
  type OpenQuestionControlLastConductorMessage,
  type OpenQuestionControlServer,
  type OperatorSessionShutdownMode,
} from '../session/open-question-control.js';
import {
  isOneTimeSecretPlatformSupported,
  ONE_TIME_SECRET_ENV,
  startOneTimeSecretControlServer,
  type OneTimeSecretControlServer,
} from '../session/one-time-secret-control.js';
import type { SessionUsageSummary } from '../usage/types.js';
import type { PendingPermission } from '../permission/pending-permission.js';
import { formatPermissionSummaryForOperator } from '../permission/format-permission-summary-for-operator.js';
import { enrichSessionUsageWithCost } from '../usage/enrich-session-usage-cost.js';
import { SessionUsageTracker } from '../usage/session-usage-tracker.js';
import type { OperatorInputBinding } from './operator-input-binding.js';
import { ConductorDispatchLifecycle } from './conductor-dispatch-lifecycle.js';
import { ConductorRecoveryInbox } from './conductor-recovery-inbox.js';
import {
  enqueueOperatorMessage as enqueueOperatorMessageEvent,
  submitOperatorInput,
} from './submit-operator-input.js';
import {
  createGitHubMonitor,
  type GitHubMonitor,
} from '../github/github-monitor.js';
import {
  resolveConductorBackendSetting,
  resolveConductorPiResourcePaths,
  resolveGitHubMonitorEnabled,
} from '../config/resolve-settings.js';
import {
  CONDUCTOR_MODEL_ID_ENV,
  DEFAULT_CONDUCTOR_MODEL_ID,
  resolveConductorModelId,
} from './resolve-conductor-model-id.js';
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
import {
  compileWorkspaceConductorSystemPrompt,
  createWorkspacePiKickoffPrompt,
} from '../prompt/compile-workspace-system-prompt.js';
import { parseWorkspaceSessionUrl } from '../workspace-run/session-url.js';
import { resolveWorkspaceIssueRef } from '../workspace-run/issue-ref.js';
import { createWorkspaceNotesTools } from '../notes/workspace-notes-tools.js';
import { loadUserInstructions } from '../prompt/load-user-instructions.js';

export type { OperatorInputContext } from './operator-input-binding.js';
export type {
  OperatorInputBinding,
  OperatorInputBindingApi,
} from './operator-input-binding.js';

export interface RunConductorSessionOptions {
  issueUrl: string;
  repoRoot: string;
  /** `ensemble run` brief ファイル本文（workspace セッション用）。 */
  briefText?: string;
  conductorCwd?: string;
  /** 呼び出し元で解決済みの config。未指定時は loadEnsembleConfig(repoRoot) で解決する。 */
  ensembleConfig?: EnsembleConfig;
  /** MCP 設定の解決オプション。未指定時は `~/.ensemble` を参照する。 */
  mcpConfigOptions?: LoadMcpConfigOptions;
  /** 作業手順・worker 定義。未指定時は loadProfile でデフォルトを解決する。 */
  profile: ResolvedProfile;
  profilePath?: string;
  resumeAgentId?: string;
  /** 新規 Store に記録する CLI package version。resume 時は保存済み値を使う。 */
  cliPackageVersion?: string;
  /** Absolute CLI entrypoint supplied by `ensemble issue` for local worker shells. */
  secretCliEntrypoint?: string;
  /** Optional factory override. Without it, `conductor.backend` selects the factory. */
  conductorAgentFactory?: ConductorAgentFactory;
  apiKey?: string;
  /**
   * Explicit model override. Resolution order: modelId > CONDUCTOR_MODEL_ID > config > backend default.
   */
  modelId?: string;
  /** CLI / caller override. Environment and merged config are resolved when omitted. */
  reasoning?: string;
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
  /** Sensitive recovery input can be inspected only when an interactive TTY binding is present. */
  operatorCanInspectRecovery?: boolean;
  /** `waitForOperatorExit` 時、自律ループ停止直後に呼ぶ（CLI の案内表示等）。 */
  onPostLoopWait?: () => void;
  /** integration 等で Fake ACP に差し替える。未指定時は実 `agent acp`。 */
  connectAcp?: ConnectWorkerAcpFn;
  /** 全 worker 共通の preset 解決（CLI > env > config > cursor）。 */
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
  /** dispatch hold の operator 向けリマインド間隔（ms）。デフォルト 30 分。 */
  dispatchHoldReminderMs?: number;
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
  /** 終了時点の conductor / worker モデル構成。 */
  sessionModels: SessionModelsSummary;
}

const OPEN_QUESTION_CONTROL_DRAIN_TIMEOUT_MS = 5_000;
const RECORDED_ANSWER_UNKNOWN_DISPATCH = {
  outcome: 'unknown',
  answerStatus: 'recorded',
  dispatchStatus: 'unknown',
} as const;

type StartupCleanupAction = () => void | Promise<void>;

/** Acquired resources are released here until the session teardown takes ownership. */
class StartupCleanupGuard {
  private readonly actions: StartupCleanupAction[] = [];
  private handedOff = false;
  private cleanupFailed = false;
  private reportCleanupError: (error: unknown) => void = () => {};

  get hasFailures(): boolean {
    return this.cleanupFailed;
  }

  get isHandedOff(): boolean {
    return this.handedOff;
  }

  add(action: StartupCleanupAction): void {
    if (this.handedOff) {
      throw new Error('Cannot register startup cleanup after session handoff');
    }
    this.actions.push(action);
  }

  setErrorReporter(report: (error: unknown) => void): void {
    this.reportCleanupError = report;
  }

  recordCleanupFailure(error: unknown): void {
    this.cleanupFailed = true;
    try {
      this.reportCleanupError(error);
    } catch {
      // Keep the startup error as the rejection reason if reporting fails.
    }
  }

  handoff(): void {
    this.handedOff = true;
    this.actions.length = 0;
  }

  async cleanup(): Promise<void> {
    if (this.handedOff) return;
    this.handedOff = true;
    for (const action of this.actions.reverse()) {
      try {
        await action();
      } catch (error) {
        this.recordCleanupFailure(error);
      }
    }
  }
}

const retainedGlobalSessionOwners = new Set<() => void>();

export async function runConductorSession(
  options: RunConductorSessionOptions,
): Promise<ConductorSessionResult> {
  const startupCleanup = new StartupCleanupGuard();
  let owner: SessionOwnership | undefined;
  let providerOwner: SessionOwnership | undefined;
  let safeToRelease = false;
  let releaseGlobalOwner: (() => void) | undefined;
  let releaseWorkspaceGate: (() => void) | undefined;
  try {
    const workspace = parseWorkspaceSessionUrl(options.issueUrl);
    if (workspace) {
      releaseWorkspaceGate = await acquireSessionMigrationReadLock();
      const anchor = await readWorkspaceAnchor(options.conductorCwd ?? process.cwd());
      if (anchor && anchor.slug !== workspace.slugKey) {
        throw new Error(`Workspace anchor changed to "${anchor.slug}"; retry the session.`);
      }
    }
    if (options.resumeAgentId) {
      releaseGlobalOwner = await acquireSessionOwnerLock(options.resumeAgentId);
      owner = await SessionOwnership.acquire(canonicalSessionResumeStorePath({
        repoRoot: options.repoRoot,
        issueUrl: options.issueUrl,
        conductorAgentId: options.resumeAgentId,
      }));
    }
    return await runConductorSessionWithStartupGuard(options, startupCleanup, {
      get: () => {
        if (!owner) throw new Error('Session ownership has not been acquired');
        return owner;
      },
      acquire: async (path) => {
        owner ??= await SessionOwnership.acquire(path);
        await owner.assertStorePath(path);
        return owner;
      },
      getProvider: () => {
        if (!providerOwner) throw new Error('Provider ownership has not been acquired');
        return providerOwner;
      },
      acquireProvider: async (path) => {
        providerOwner = await SessionOwnership.acquireProvider(path);
        return providerOwner;
      },
      markSafeToRelease: () => { safeToRelease = true; },
      acquireGlobal: async (id) => { releaseGlobalOwner ??= await acquireSessionOwnerLock(id); },
    });
  } catch (error) {
    const startupWasActive = !startupCleanup.isHandedOff;
    await startupCleanup.cleanup();
    if (startupWasActive && !startupCleanup.hasFailures) safeToRelease = true;
    throw error;
  } finally {
    const owners = [providerOwner, owner].filter((item): item is SessionOwnership => item !== undefined);
    if (safeToRelease) {
      await Promise.all(owners.map((item) => item.closeWritesAndDrain()));
      try {
        for (const item of owners) item.release();
        releaseGlobalOwner?.();
      } finally {
        releaseWorkspaceGate?.();
      }
    } else {
      for (const item of owners) item.retainUntilProcessExit();
      if (releaseGlobalOwner) retainedGlobalSessionOwners.add(releaseGlobalOwner);
      if (releaseWorkspaceGate) retainedGlobalSessionOwners.add(releaseWorkspaceGate);
    }
  }
}

interface SessionOwnershipLifecycle {
  get(): SessionOwnership;
  acquire(path: string): Promise<SessionOwnership>;
  getProvider(): SessionOwnership;
  acquireProvider(path: string): Promise<SessionOwnership>;
  markSafeToRelease(): void;
  acquireGlobal(id: string): Promise<void>;
}

async function runConductorSessionWithStartupGuard(
  options: RunConductorSessionOptions,
  startupCleanup: StartupCleanupGuard,
  ownershipLifecycle: SessionOwnershipLifecycle,
): Promise<ConductorSessionResult> {
  const workspaceSession = parseWorkspaceSessionUrl(options.issueUrl);
  const userInstructions = await loadUserInstructions({
    userEnsembleRoot: options.mcpConfigOptions?.userEnsembleRoot,
  });
  const ensembleConfig =
    options.ensembleConfig ?? (await loadEnsembleConfig(options.repoRoot));
  let ensembleConfigDigestScheme: EnsembleConfigDigestScheme | undefined =
    'resume-feasibility';
  let ensembleConfigDigest: string | undefined =
    computeResumeFeasibilityConfigDigest(ensembleConfig);
  let acpModelConfigDigest: string | undefined =
    computeAcpModelConfigDigest(ensembleConfig);
  const resolvedConductorModelId = resolveConductorModelId(options.modelId, {
    config: ensembleConfig,
  });
  const hasInvocationModelOverride = Boolean(
    options.modelId?.trim() ||
      process.env[CONDUCTOR_MODEL_ID_ENV]?.trim(),
  );
  // Built-in factories understand `default` as their backend default. For a
  // custom factory, preserve the optional contract when the default comes
  // from config/code defaults. Keep an invocation-level `default` sentinel so
  // the factory can honor it over its own lower-priority defaults.
  const conductorFactoryModelId =
    options.conductorAgentFactory &&
    resolvedConductorModelId === DEFAULT_CONDUCTOR_MODEL_ID &&
    !hasInvocationModelOverride
      ? undefined
      : resolvedConductorModelId;
  const conductorReasoning = resolveConductorReasoning(options.reasoning, {
    config: ensembleConfig,
  });
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
  startupCleanup.setErrorReporter((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    sessionLogger.emit({
      type: 'harness.warning',
      message: `起動失敗後の後始末に失敗しました: ${detail}`,
    });
  });
  attachLegacySessionCallbacks(sessionLogger, options);
  const conductorFailureLog = createConductorFailureLog(() => {
    sessionLogger.emit({ type: 'harness.warning', message: 'conductor の失敗ログを保存できません。詳細は活動ログを確認してください。' });
  });

  startupCleanup.add(() => conductorFailureLog.close());

  const expiredHistory = await pruneExpiredToolCallSnapshotHistoryFiles(
    { repoRoot: options.repoRoot, issueUrl: options.issueUrl },
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
  let harnessPhase: HarnessPhase | undefined;
  let harnessModifiedAt: number | undefined;
  let reportHarnessActivity: (
    kind: 'conductor' | 'worker',
    active: boolean,
  ) => void = () => {};
  let openQuestionControlServer: OpenQuestionControlServer | undefined;
  let oneTimeSecretControlServer: OneTimeSecretControlServer | undefined;
  const secretWorkerTokens = new Map<string, string>();
  let lastConductorMessage: OpenQuestionControlLastConductorMessage | null =
    null;
  const conductorMessages: OpenQuestionControlConductorMessage[] = [];
  const eventQueue = new SessionEventQueue();
  // A failed round becomes idle before its inbox notification is dispatched.
  // Keep each failure until delivery succeeds or the operator confirms
  // recovery from its unconfirmed delivery attempt.
  let nextWorkerFailureId = 0;
  const pendingWorkerFailures = new Set<number>();
  const unconfirmedWorkerFailures = new Map<string, Set<number>>();
  const unassignedWorkerFailures = new Map<string, number[]>();
  const workerFailureIds = new WeakMap<WorkerFailureRecord, number>();
  const resumeNoticeDetails = new Set<string>();
  const reportResumeNotice = (message: string): void => {
    if (resumeNoticeDetails.has(message)) return;
    resumeNoticeDetails.add(message);
    sessionLogger.emit({ type: 'harness.warning', message });
  };
  const recoveryInbox = new ConductorRecoveryInbox();
  const dispatchLifecycle =
    new ConductorDispatchLifecycle<ConductorDispatchPayload>();
  startupCleanup.add(() => recoveryInbox.dispose());
  const openQuestionDispatchReceipts = new WeakMap<
    SessionEvent,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const pendingOpenQuestionDispatchReceipts = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  const dispatchHoldState = createDispatchHoldState();
  let dispatchHoldReminderMonitor: DispatchHoldReminderMonitor | undefined;
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
    dispatchHoldReminderMonitor?.onHoldChanged(change.hold);
  };
  let activeProfile = options.profile;
  let activeLazyWorkers = ensembleConfig.session.lazyWorkers;
  const workerSessions = new Map<
    string,
    WorkerSessionResumeStore
  >();
  const workerSessionOrigins = new Map<string, { repoRoot: string; issueUrl: string }>();
  let githubMonitorCursor: GitHubMonitorCursor | undefined;
  let githubMonitor: GitHubMonitor | undefined;
  let activeResumeStorePath: string | undefined;
  let activeLocatedResumeStore: LocatedSessionResumeStore | undefined;
  let activeResumeStoreVersion: SessionResumeStore['version'] = SESSION_RESUME_STORE_VERSION;
  let createdHarnessCliVersion = options.cliPackageVersion;
  let drainStartupResumeStoreWrites = async () => {};
  const pendingGitHubRecoveries: number[] = [];
  const conductorCwd = options.conductorCwd ?? process.cwd();
  let cursorBootstrapRunId: string | undefined;
  const cursorBootstrapState: CursorBootstrapState | undefined =
    conductorBackend === 'cursor' ? { status: 'incomplete' } : undefined;
  const mcpServers = await resolveConductorMcpServers(
    options.repoRoot,
    ensembleConfig.conductor.mcp?.servers ?? [],
    options.mcpConfigOptions,
  );
  const mcpConfigDigest = computeMcpConfigDigest(mcpServers);
  const mcpConfigConfigured = Object.keys(mcpServers).length > 0;
  let resumeToolCallSnapshots: StoredToolCallSnapshot[] = [];
  let toolCallHistoryNeedsRewrite = false;

  if (options.resumeAgentId) {
    const owner = ownershipLifecycle.get();
    const locatedResumeStore = await owner.runWrite((lease) =>
      requireLocatedSessionResumeStoreForResume({
      repoRoot: options.repoRoot,
      conductorAgentId: options.resumeAgentId!,
      issueUrl: options.issueUrl,
      owner,
      lease,
    }));
    const loadedResumeStore = locatedResumeStore.resumeStore;
    activeResumeStoreVersion = loadedResumeStore.version;
    activeLocatedResumeStore = locatedResumeStore;
    // A resume keeps its origin version; a legacy store stays without one.
    createdHarnessCliVersion = loadedResumeStore.createdHarnessCliVersion;
    activeResumeStorePath = locatedResumeStore.path;
    const savedConfigDigestScheme =
      loadedResumeStore.ensembleConfigDigestScheme;
    const effectiveConfigDigestScheme = savedConfigDigestScheme ?? 'full';
    const currentEnsembleConfigDigest =
      effectiveConfigDigestScheme === 'resume-feasibility'
        ? computeResumeFeasibilityConfigDigest(ensembleConfig)
        : computeEnsembleConfigDigest(ensembleConfig);
    assertSessionResumeStoreMatches(loadedResumeStore, {
      conductorAgentId: options.resumeAgentId,
      issueUrl: options.issueUrl,
    });
    if (resolvePath(loadedResumeStore.repoRoot) !== resolvePath(options.repoRoot)) {
      reportResumeNotice(
        `保存時の repoRoot ${loadedResumeStore.repoRoot} と現在の repoRoot ${options.repoRoot} が異なります。現在の clone を使って再開します。Store に commit SHA がないため、保存時 clone にだけある local commit / 未コミット変更は照合・復元できません。`,
      );
      if (!(await pathExists(loadedResumeStore.repoRoot))) {
        reportResumeNotice(
          `保存時の clone ${loadedResumeStore.repoRoot} は現在参照できません。そこにだけあった未コミット変更は復元できず、Store に commit SHA がないため欠落した commit の有無も照合できません。`,
        );
      }
    }
    if (
      loadedResumeStore.conductorCwd !== undefined &&
      resolvePath(loadedResumeStore.conductorCwd) !== resolvePath(conductorCwd)
    ) {
      reportResumeNotice(
        `保存時の conductor cwd ${loadedResumeStore.conductorCwd} は現在の cwd ${conductorCwd} とは異なります。現在の cwd で backend resume を試みます。以前の cwd にだけある local state は引き継がれず、Store に commit SHA がないため commit の差も照合できません。`,
      );
      if (!(await pathExists(loadedResumeStore.conductorCwd))) {
        reportResumeNotice(
          `保存時の conductor cwd ${loadedResumeStore.conductorCwd} は見つからないため、以前の workspace のローカル状態は復元できません。`,
        );
      }
    }
    const savedBackend = loadedResumeStore.conductorBackend ?? 'cursor';
    if (savedBackend !== conductorBackend) {
      reportResumeNotice(
        `保存時の conductor backend は ${savedBackend}、現在の設定は ${conductorBackend} です。現在の backend で復元を試みます。復元できなければ session は失敗として扱います。`,
      );
    }
    if (
      loadedResumeStore.ensembleConfigDigest !== undefined &&
      loadedResumeStore.ensembleConfigDigest !== currentEnsembleConfigDigest
    ) {
      reportResumeNotice(
        '保存時と現在の Ensemble config が異なります。保存時の設定には戻さず、現在の clone の config で復元を試みます。',
      );
    } else if (loadedResumeStore.ensembleConfigDigest === undefined) {
      reportResumeNotice(
        'SessionResumeStore に config digest がないため差分を比較できません。現在の clone の config で復元します。',
      );
    }
    if (
      loadedResumeStore.mcpConfigDigest === undefined
        ? mcpConfigConfigured
        : loadedResumeStore.mcpConfigDigest !== mcpConfigDigest
    ) {
      reportResumeNotice(
        '保存時と現在の MCP config が異なるか、保存時の digest がありません。現在の clone の MCP config を使って復元を試みます。',
      );
    }
    if (
      JSON.stringify(loadedResumeStore.profile) !==
      JSON.stringify(options.profile)
    ) {
      reportResumeNotice(
        '保存時の team profile と現在の clone で解決した profile が異なります。以降は現在の profile を使います。',
      );
    }
    const hasComparableLegacyFullDigest =
      effectiveConfigDigestScheme === 'full' &&
      loadedResumeStore.ensembleConfigDigest !== undefined;
    if (
      loadedResumeStore.acpModelConfigDigest === undefined &&
      !hasComparableLegacyFullDigest
    ) {
      sessionLogger.emit({
        type: 'harness.warning',
        message:
          'SessionResumeStore has no ACP model config digest; this diagnostic metadata is unavailable and will not be backfilled. Resume is not blocked by its absence.',
      });
    }
    // Keep the persisted scheme and digest paired across resume and flush.
    // Legacy stores without a digest remain unverifiable until a new session
    // is started; a resume must not silently relabel their existing state.
    ensembleConfigDigestScheme = savedConfigDigestScheme;
    ensembleConfigDigest = loadedResumeStore.ensembleConfigDigest;
    // This digest describes the config used when the session was first
    // recorded. Keep it as diagnostic metadata; model changes do not gate
    // resume, and a missing legacy value must not be backfilled.
    acpModelConfigDigest = loadedResumeStore.acpModelConfigDigest;
    // A previously completed lifecycle no longer describes this instance once
    // resume begins. Persist unknown before restoring or attaching anything so
    // a crash during backend resume cannot leave stale `closed` / `exited` data
    // behind. Startup cleanup restores the previous record only if every
    // acquired resource is released successfully; otherwise keep this record
    // marked unknown/running so it does not claim a possibly active session is
    // closed.
    cursorBootstrapRunId = loadedResumeStore.cursorBootstrapRunId;
    if (cursorBootstrapState) {
      const savedBootstrapComplete =
        loadedResumeStore.cursorBootstrapComplete;
      cursorBootstrapState.status =
        savedBootstrapComplete === undefined
          ? 'unknown'
          : savedBootstrapComplete
            ? 'complete'
            : 'incomplete';
      if (cursorBootstrapState.status === 'unknown') {
        if (
          options.operatorCanInspectRecovery !== true ||
          !options.bindOperatorInput
        ) {
          throw new Error(
            [
              '旧 Cursor session の SessionResumeStore に bootstrap 状態がなく、compiled prompt が provider に届いたか判定できません。',
              '安全のため backend resume と event dispatch は開始しませんでした。',
              'stdin / stdout / stderr がすべて対話 TTY の環境で `--continue` し、`/recovery bootstrap assume-complete` または `/recovery bootstrap assume-incomplete` を明示してください。',
              'complete は prompt を再送せず、incomplete は次の新しい event に prompt を添えます。どちらも失敗 input や旧 queue は再送しません。',
            ].join('\n'),
          );
        }
        sessionLogger.emit({
          type: 'harness.warning',
          message: [
            '旧 Cursor session の SessionResumeStore に bootstrap 状態がなく、compiled prompt が provider に届いたか判定できません。',
            'operator が `/recovery bootstrap assume-complete` または `/recovery bootstrap assume-incomplete` を選んで判断を保存するまで、すべての event dispatch を停止します。',
            'どちらの選択も失敗 input や旧 queue を復元・再送しません。',
          ].join(' '),
        });
      }
    }
    const resumeStore: SessionResumeStore = {
      ...loadedResumeStore,
      lifecycle: 'unknown',
      harnessPhase: 'running',
      modifiedAt: Date.now(),
      harnessSocketPath: undefined,
      updatedAt: Date.now(),
    };
    harnessPhase = 'running';
    harnessModifiedAt = resumeStore.modifiedAt;
    let resumeStoreActivationCommitted = false;
    startupCleanup.add(async () => {
      if (!resumeStoreActivationCommitted) return;
      await drainStartupResumeStoreWrites();
      if (startupCleanup.hasFailures) {
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            '起動失敗後の後始末が完了しなかったため、再開記録を unknown/running のまま保ちます。',
        });
        return;
      }
      await owner.runWrite((lease) =>
        saveSessionResumeStore(locatedResumeStore.path, loadedResumeStore, owner, lease));
    });
    await owner.runWrite((lease) =>
      saveSessionResumeStore(activeResumeStorePath!, resumeStore, owner, lease));
    resumeStoreActivationCommitted = true;
    const historyOwner = await SessionOwnership.acquireProvider(activeResumeStorePath!);
    let history: Awaited<ReturnType<typeof loadToolCallSnapshotHistory>>;
    try {
      history = await loadToolCallSnapshotHistory({
        repoRoot: options.repoRoot,
        conductorAgentId: options.resumeAgentId,
        issueUrl: options.issueUrl,
      });
    resumeToolCallSnapshots = history.entries;
    toolCallHistoryNeedsRewrite = history.needsRewrite;
    if (history.warning) {
      sessionLogger.emit({
        type: 'harness.warning',
        message: `${history.warning}; the session will continue without affected history`,
      });
    }
    const openQuestionsPath = sessionSnapshotPaths(
      options.repoRoot,
      locatedResumeStore,
      'open-questions',
    )[0]!;
    let openQuestionsSnapshot = await loadOpenQuestionsStore(openQuestionsPath);
    if (openQuestionsSnapshot) {
      openQuestions.restore(openQuestionsSnapshot);
    } else {
      const legacySnapshot = {
        sequence: resumeStore.sequence,
        openQuestions: resumeStore.openQuestions,
      };
      openQuestions.restore(legacySnapshot);
      try {
        await historyOwner.runWrite((lease) =>
          saveOpenQuestionsStore(openQuestionsPath, legacySnapshot, historyOwner, lease));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            `旧形式の SessionResumeStore から復元した open question を YAML にバックフィルできませんでした。今回のセッションは継続します。 error=${detail}`,
        });
      }
    }
    } finally {
      await historyOwner.closeWritesAndDrain();
      historyOwner.release();
    }
    githubMonitorCursor = resumeStore.githubMonitor;
    for (const [name, worker] of Object.entries(resumeStore.workers)) {
      workerSessions.set(name, {
        ...worker,
        ...(worker.originAcpCwd || worker.acpCwd
          ? { originAcpCwd: worker.originAcpCwd ?? worker.acpCwd }
          : {}),
        ...(worker.originAcpSpawn || worker.acpSpawn
          ? { originAcpSpawn: historySpawnFingerprint((worker.originAcpSpawn ?? worker.acpSpawn)!) }
          : {}),
      });
      workerSessionOrigins.set(name, {
        repoRoot: worker.repoRoot ?? resumeStore.repoRoot,
        issueUrl: worker.issueUrl ?? resumeStore.issueUrl,
      });
    }
  }

  const conductorAgentFactory =
    options.conductorAgentFactory ?? createConductorAgentFactory(conductorBackend);

  if (!workspaceSession) {
    const githubAuth = await resolveGitHubAuthToken({ config: ensembleConfig });
    if (!githubAuth.token) {
      sessionLogger.emit({
        type: 'harness.warning',
        message: GITHUB_AUTH_HINT,
      });
    }
  }

  let systemPrompt: string;
  if (workspaceSession) {
    systemPrompt = compileWorkspaceConductorSystemPrompt({
      workspaceSlugKey: workspaceSession.slugKey,
      profile: activeProfile,
      agentModule: resolveAgentPromptModule('conductor', activeProfile.agents),
      userInstructions,
      briefText: options.briefText,
    });
  } else {
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
  }

  const ownsShutdownController = !options.shutdownSignal;
  const shutdownController = ownsShutdownController
    ? new AbortController()
    : undefined;
  const shutdownSignal =
    options.shutdownSignal ?? shutdownController!.signal;
  const shutdownIntentController = new AbortController();
  const operatorTerminationController = new AbortController();
  const drainedShutdownController = new AbortController();
  const driverShutdownSignal = AbortSignal.any([
    drainedShutdownController.signal,
    operatorTerminationController.signal,
  ]);
  const abortAfterOpenQuestionDrain = (
    controller: AbortController,
  ): void => {
    const activeControlServer = openQuestionControlServer;
    if (!activeControlServer) {
      controller.abort();
      return;
    }
    const reportDrainFailure = (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      sessionLogger.emit({
        type: 'harness.warning',
        message: `Open Question control drain failed: ${detail}`,
      });
    };
    const quiescing = activeControlServer.quiesce();
    if (!activeControlServer.hasInFlightRequests()) {
      void quiescing.catch(reportDrainFailure);
      controller.abort();
      return;
    }
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const drainDeadline = new Promise<'timeout'>((resolve) => {
      drainTimeout = setTimeout(
        () => resolve('timeout'),
        OPEN_QUESTION_CONTROL_DRAIN_TIMEOUT_MS,
      );
    });
    const drainResult = quiescing.then(
      () => 'drained' as const,
      (error: unknown) => {
        reportDrainFailure(error);
        return 'failed' as const;
      },
    );
    void Promise.race([drainResult, drainDeadline]).then((result) => {
      if (drainTimeout) clearTimeout(drainTimeout);
      if (result === 'timeout') {
        sessionLogger.emit({
          type: 'harness.warning',
          message: `Open Question control drain exceeded ${OPEN_QUESTION_CONTROL_DRAIN_TIMEOUT_MS}ms; aborting conductor dispatch. Accepted answers may have unknown notification outcomes.`,
        });
      }
      controller.abort();
    });
  };
  const onShutdownSignal = () => {
    shutdownIntentController.abort();
    abortAfterOpenQuestionDrain(drainedShutdownController);
  };
  let unregisterProcessSignalHandlers = () => {};
  const removeShutdownDrainListener = () =>
    shutdownSignal.removeEventListener('abort', onShutdownSignal);
  const onSignal = () => shutdownController!.abort();
  unregisterProcessSignalHandlers = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    removeShutdownDrainListener();
  };
  startupCleanup.add(() => unregisterProcessSignalHandlers());
  shutdownSignal.addEventListener('abort', onShutdownSignal, { once: true });
  if (shutdownSignal.aborted) onShutdownSignal();
  if (
    ownsShutdownController &&
    options.registerProcessSignalHandlers !== false
  ) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  const permissionPipeline =
    options.permissionPipeline ??
    new PermissionPipeline({ policy: options.permissionPolicy });

  let scheduleSessionResumeStoreFlush = () => {};
  let flushSessionResumeStore: (lifecycle?: SessionLifecycle) => Promise<void> =
    async () => {};
  let commitWorkerSessionRecovery: (
    notification: import('../runtime/types.js').WorkerSessionRecoveredNotification,
  ) => Promise<void> = async () => { throw new Error('Resume store is not ready'); };
  let commitWorkerSessionId: (
    notification: import('../runtime/types.js').WorkerSessionAttachedNotification,
  ) => Promise<void> = async () => { throw new Error('Resume store is not ready'); };
  let commitWorkerHandoffConfirmed: (name: string, sessionId: string) => Promise<void> =
    async () => { throw new Error('Resume store is not ready'); };
  let scheduleToolCallHistoryFlush = () => {};
  let flushToolCallHistory = async () => {};
  let toolCallHistoryDirty = toolCallHistoryNeedsRewrite;

  const sessionState = sessionStateFromProfile(activeProfile);

  const issue = workspaceSession
    ? resolveWorkspaceIssueRef(workspaceSession.slugKey)
    : parseIssueUrl(options.issueUrl);
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
  const piAgentDir = resolveConductorPiResourcePaths({
    repoRoot: options.repoRoot,
    config: ensembleConfig,
  }).agentDir;
  const workers = profileWorkersToSessionSpecs(activeProfile, {
    defaultAcp: options.defaultAcp,
    spawnBase,
    repoRoot: options.repoRoot,
    ...(workspaceSession
      ? { workspaceSlugKey: workspaceSession.slugKey }
      : { issueNumber: issue.number }),
    ...(piAgentDir ? { piAgentDir } : {}),
    onWarning: (message) =>
      sessionLogger.emit({ type: 'harness.warning', message }),
  });
  if (workers.length > 0) {
    validateWorkerAcpPrerequisites(
      workers.map((worker) =>
        resolveWorkerAcpSpawn({
          defaultOptions: options.defaultAcp,
          modelTag: worker.modelTag,
        }),
      ),
    );
    finalizeSessionWorkerSpecs(
      workers,
      options.repoRoot,
      issue.number,
      options.defaultAcp,
      piAgentDir,
      workspaceSession?.slugKey,
    );
  }
  const workerAcpFingerprints = new Map(
    workers.map((worker) => [worker.name, worker.acpFingerprint] as const),
  );
  let teardownStarted = false;
  const workerWorktree =
    options.workerWorktree ??
    (workers.length > 0
      ? workspaceSession
        ? { path: resolvePath(conductorCwd), branch: '', issue, inRepo: true }
        : await resolveWorkerWorkspace(
            options.repoRoot,
            issue,
            options.workerWorktreeMode ?? 'isolated',
            {
              resume: Boolean(options.resumeAgentId),
              onNotice: reportResumeNotice,
            },
          )
      : undefined);

  if (options.resumeAgentId) {
    const currentWorkers = new Map(
      workers.map((worker) => [worker.name, worker] as const),
    );
    for (const [name, savedWorker] of workerSessions) {
      if (!currentWorkers.has(name)) {
        reportResumeNotice(
          `保存 session に worker「${name}」がありますが、現在の profile には定義がありません。この worker session は復元対象から外れます。`,
        );
        continue;
      }
      const currentWorker = currentWorkers.get(name)!;
      const savedAcpSpawn = savedWorker.acpSpawn;
      const currentAcpSpawn = currentWorker.acpFingerprint;
      if (
        savedAcpSpawn &&
        currentAcpSpawn &&
        (savedAcpSpawn.preset !== currentAcpSpawn.preset ||
          (savedAcpSpawn.preset === 'pi' &&
            currentAcpSpawn.preset === 'pi' &&
            (savedAcpSpawn.piRuntime ?? 'byo') !==
              (currentAcpSpawn.piRuntime ?? 'byo')) ||
          (savedAcpSpawn.preset === 'custom' &&
            currentAcpSpawn.preset === 'custom' &&
            (savedAcpSpawn.command !== currentAcpSpawn.command ||
              JSON.stringify(savedAcpSpawn.args) !==
                JSON.stringify(currentAcpSpawn.args))))
      ) {
        reportResumeNotice(
          `worker「${name}」の保存時 ACP preset/runtime と現在の設定が異なります。現在の設定で ACP session/load を試みます。`,
        );
      }
      if (!savedWorker.acpCwd) continue;
      const currentCwd =
        currentWorker.resolvedWorkspacePath ?? workerWorktree?.path;
      if (
        currentCwd &&
        resolvePath(savedWorker.acpCwd) !== resolvePath(currentCwd)
      ) {
        reportResumeNotice(
          `worker「${name}」の保存時 ACP cwd ${savedWorker.acpCwd} と現在の workspace ${currentCwd} が異なります。現在の workspace で ACP session/load を試みます。以前の cwd にだけある local changes はコピーされず、Store に commit SHA がないため commit の差も照合できません。`,
        );
        if (!(await pathExists(savedWorker.acpCwd))) {
          reportResumeNotice(
            `worker「${name}」の保存時 ACP cwd ${savedWorker.acpCwd} は見つかりません。そこにだけあった未コミット変更は復元できず、保存 Store に commit SHA がないため欠落 commit の有無も照合できません。`,
          );
        }
      }
    }
  }

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
    ...(userInstructions ? { userInstructions } : {}),
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
      const savedWorker = workerSessions.get(result.name);
      if (savedWorker && savedWorker.acpSessionId !== result.acpSessionId) {
        sessionLogger.emit({
          type: 'harness.warning',
          message: `worker ${result.name} の古い session 完了通知を保存せず破棄しました。`,
        });
        return;
      }
      workerSessions.set(result.name, {
        ...workerSessions.get(result.name),
        acpSessionId: result.acpSessionId,
        ...(workspaceSession && result.source === 'harness' && result.promptResult.stopReason === 'end_turn' && !attached?.session.resumed ? { workspacePromptVersion: WORKSPACE_WORKER_PROMPT_VERSION } : {}),
        acpCwd: attached?.session.acpCwd ?? workerWorktree?.path,
        ...(!savedWorker?.originAcpCwd
          ? { originAcpCwd: attached?.session.acpCwd ?? workerWorktree?.path }
          : {}),
        ...(!savedWorker?.originAcpSpawn && workerAcpFingerprints.get(result.name)
          ? { originAcpSpawn: historySpawnFingerprint(workerAcpFingerprints.get(result.name)!) }
          : {}),
        ...(workerAcpFingerprints.get(result.name)
          ? { acpSpawn: workerAcpFingerprints.get(result.name) }
          : {}),
      });
      eventQueue.enqueue({ type: 'worker.completed', result });
      scheduleSessionResumeStoreFlush();
    },
    onWorkerSessionRecovered: async (notification) => {
      try {
        await commitWorkerSessionRecovery(notification);
      } catch (error) {
        reportResumeStoreFlushFailure(error);
        throw error;
      }
      const detail =
        notification.reason === 'workspace_prompt_migration'
          ? 'workspace worker の旧 prompt 世代を移行するため'
          : notification.reason === 'session_load_failed'
          ? '保存済み ACP session を読み込めなかったため'
          : notification.reason === 'prompt_history_unreadable'
            ? '保存済み ACP thread の履歴を読めなかったため'
            : '明示的な再作成が指示されたため';
      sessionLogger.emit({
        type: 'harness.warning',
        message: `worker.session.recovered name=${notification.name} kind=${notification.kind}: ${detail}新しい session に切り替えました。inspect_worker_handoff で報告を読み、中断操作と不足情報を確認して confirm_worker_handoff を呼ぶまで新しい指示は受け付けません。`,
      });
      eventQueue.enqueue({
        type: 'worker.session.recovered',
        name: notification.name,
        kind: notification.kind,
        reason: notification.reason,
      });
    },
    onWorkerSessionAttached: (notification) => commitWorkerSessionId(notification),
    onWorkerSessionRestarted: (notification) => commitWorkerSessionId(notification),
    onWorkerHandoffConfirmed: (name, sessionId) => commitWorkerHandoffConfirmed(name, sessionId),
    onWorkerFailed: (failure) => {
      // Notifications are serialized by the inbox, preserving each worker's
      // telemetry order even if a later round fails before this one is sent.
      const pending = unassignedWorkerFailures.get(failure.workerId);
      const id = pending?.shift();
      if (id !== undefined) workerFailureIds.set(failure, id);
      if (pending?.length === 0) unassignedWorkerFailures.delete(failure.workerId);
      sessionLogger.emit({ type: 'worker.failed', failure });
      eventQueue.enqueue({ type: 'worker.failed', failure });
    },
    onPromptTelemetry: (event) => {
      switch (event.phase) {
        case 'started':
          reportHarnessActivity('worker', true);
          sessionLogger.emit({
            type: 'harness.worker.prompt.started',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            source: event.source,
          });
          break;
        case 'completed':
          reportHarnessActivity('worker', false);
          sessionLogger.emit({
            type: 'harness.worker.prompt.completed',
            name: event.name,
            kind: event.kind,
            workerId: event.workerId,
            source: event.source,
            stopReason: event.stopReason!,
          });
          break;
        case 'failed': {
          const id = ++nextWorkerFailureId;
          pendingWorkerFailures.add(id);
          const pending = unassignedWorkerFailures.get(event.workerId) ?? [];
          pending.push(id);
          unassignedWorkerFailures.set(event.workerId, pending);
          reportHarnessActivity('worker', false);
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
  startupCleanup.add(() => workerSession.stop({ force: true }));

  const recordAnsweredQuestion = (answered: OpenQuestion) => {
    const record = openQuestionToEscalationRecord(answered);
    if (record) {
      escalations.push(record);
      sessionLogger.emit({ type: 'escalation.recorded', record });
      options.onEscalated?.(record);
    }
    scheduleSessionResumeStoreFlush();
  };

  const askHumanTools = createAskHumanTool({
    registry: openQuestions,
    onEnqueued: (question) => {
      sessionLogger.emit({ type: 'open.question.enqueued', question });
      options.onOpenQuestionEnqueued?.(question);
      scheduleSessionResumeStoreFlush();
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
  const recreateWorkerTools: import('./conductor-tool.js').ConductorToolSet = {
    restart_worker: {
      name: 'restart_worker',
      description: 'Restart an idle or failed worker ACP process and strictly load its existing session, preserving conversation history. Processing, attaching, queued, sleeping, or workers without a confirmed session ID cannot be restarted. If strict load fails, retry restart_worker or choose recreate_worker only when losing the old conversation is acceptable.',
      inputSchema: {
        type: 'object',
        properties: {
          worker: { type: 'string', enum: activeProfile.workers.map((worker) => worker.name) },
        },
        required: ['worker'],
      },
      async execute(args) {
        if (teardownStarted) throw new Error('Worker restart is unavailable during shutdown.');
        const name = String(args.worker ?? '').trim();
        const sessionId = await workerSession.runtime.restartWorker(name);
        return {
          content: [{
            type: 'text',
            text: `worker「${name}」を再起動し、既存 ACP session「${sessionId}」を読み込みました。会話履歴を引き継いでいます。`,
          }],
        };
      },
    },
    recreate_worker: {
      name: 'recreate_worker',
      description: 'Explicitly create a new worker session when its prior conversation cannot or should not be restored. The worker must be idle or failed. History is not preserved; inspect interrupted operations before issuing new work.',
      inputSchema: {
        type: 'object',
        properties: {
          worker: { type: 'string', enum: activeProfile.workers.map((worker) => worker.name) },
        },
        required: ['worker'],
      },
      async execute(args) {
        if (teardownStarted) throw new Error('Worker recreation is unavailable during shutdown.');
        const name = String(args.worker ?? '').trim();
        const previous = workerSessions.get(name);
        if (!previous) throw new Error(`No saved worker session for "${name}".`);
        const handoff = await workerSession.runtime.recreateWorker(name, previous.acpSessionId);
        return {
          content: [{ type: 'text', text: `worker「${name}」を新しい session として再作成しました。旧会話は引き継がれていません。指示を送る前に、中断した作業と副作用を確認してください。\n引き継ぎ報告:\n${handoff || '(報告なし)'}` }],
        };
      },
    },
    inspect_worker_handoff: {
      name: 'inspect_worker_handoff',
      description: 'Read the completed worker handoff report and obtain its confirmation token.',
      inputSchema: {
        type: 'object',
        properties: { worker: { type: 'string', enum: activeProfile.workers.map((worker) => worker.name) } },
        required: ['worker'],
      },
      async execute(args) {
        const name = String(args.worker ?? '').trim();
        const { report, token } = workerSession.runtime.inspectWorkerHandoff(name);
        return { content: [{ type: 'text', text: `Worker handoff:\n${report}\nConfirmation token: ${token}` }] };
      },
    },
    confirm_worker_handoff: {
      name: 'confirm_worker_handoff',
      description: 'After reviewing the worker handoff and checking interrupted operations and missing information, allow new instructions for the recreated worker.',
      inputSchema: {
        type: 'object',
        properties: { worker: { type: 'string', enum: activeProfile.workers.map((worker) => worker.name) }, token: { type: 'string' } },
        required: ['worker', 'token'],
      },
      async execute(args) {
        const name = String(args.worker ?? '').trim();
        await workerSession.runtime.confirmWorkerHandoff(name, String(args.token ?? ''));
        return { content: [{ type: 'text', text: `Handoff confirmed for worker "${name}".` }] };
      },
    },
  };

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
      await flushSessionResumeStore();
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
      await flushSessionResumeStore();
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
      const owner = ownershipLifecycle.getProvider();
      const previousWrite = sessionStateWriteQueue;
      const write = owner.runWrite((lease) => previousWrite.then(() =>
        saveSessionStatusLine(
          sessionStateStorePath({
            repoRoot: options.repoRoot,
            conductorAgentId: conductorAgent.agentId,
            issueUrl: options.issueUrl,
            location: 'canonical-slug',
          }),
          statusLine,
          undefined,
          owner,
          lease,
        ),
      ));
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
    .registerAll(recreateWorkerTools);
  if (!workspaceSession) {
    conductorToolRegistry
      .registerAll(registerGitHubWatchTools)
      .registerAll(unregisterGitHubWatchTools);
  } else {
    conductorToolRegistry.registerAll(
      createWorkspaceNotesTools({
        repoRoot: options.repoRoot,
        slugKey: workspaceSession.slugKey,
      }),
    );
  }
  conductorToolRegistry
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
    modelId: conductorFactoryModelId,
    ...(conductorReasoning !== undefined
      ? { reasoning: conductorReasoning }
      : {}),
    ...(conductorBackend === 'pi'
      ? {
          issueUrl: options.issueUrl,
          pi: resolveConductorPiResourcePaths({
            repoRoot: options.repoRoot,
            config: ensembleConfig,
          }),
          ...(activeLocatedResumeStore
            ? {
                resumeCwds: [
                  activeLocatedResumeStore.resumeStore.conductorCwd,
                  activeLocatedResumeStore.resumeStore.repoRoot,
                ].filter((cwd): cwd is string => Boolean(cwd)),
              }
            : {}),
        }
      : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    customTools: conductorToolRegistry.toRecord(),
    ...(conductorBackend === 'pi'
      ? {
          onContextCompaction: () =>
            sessionUsageTracker.recordContextCompaction(),
          onCompactionEvent: (event) => {
            const logEvent = { type: 'conductor.compaction' as const, event };
            conductorFailureLog.emit(logEvent);
            sessionLogger.emit(logEvent);
          },
          onRetryEvent: (event) => {
            const logEvent = { type: 'conductor.retry' as const, event };
            conductorFailureLog.emit(logEvent);
            sessionLogger.emit(logEvent);
          },
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

  shutdownSignal.throwIfAborted();
  try {
    conductorAgent = options.resumeAgentId
      ? await conductorAgentFactory.resume(
          options.resumeAgentId,
          conductorOptions,
        )
      : await conductorAgentFactory.create(conductorOptions);
  } catch (error) {
    conductorFailureLog.abandon();
    if (isConductorAgentFactoryCleanupIncomplete(error)) {
      startupCleanup.recordCleanupFailure(error);
    }
    throw error;
  }
  startupCleanup.add(async () => {
    await closeConductorAgentOnce(conductorAgent, {
      forResume: Boolean(options.resumeAgentId),
    });
  });
  if (!options.resumeAgentId) {
    await ownershipLifecycle.acquire(canonicalSessionResumeStorePath({
      repoRoot: options.repoRoot, issueUrl: options.issueUrl, conductorAgentId: conductorAgent.agentId,
    }));
  }
  await ownershipLifecycle.acquireProvider(canonicalSessionResumeStorePath({
    repoRoot: options.repoRoot, issueUrl: options.issueUrl, conductorAgentId: conductorAgent.agentId,
  }));
  try {
    conductorFailureLog.setPath(conductorFailureLogPath({
      repoRoot: options.repoRoot, issueUrl: options.issueUrl, conductorAgentId: conductorAgent.agentId,
    }), resolveUserEnsembleRoot());
  } catch {
    conductorFailureLog.abandon();
    sessionLogger.emit({ type: 'harness.warning', message: 'conductor の失敗ログの保存先を決定できません。' });
  }
  // Factories may not be abortable while pending. Register the returned agent
  // before checking shutdown so a late success is still closed by the guard.
  shutdownSignal.throwIfAborted();
  if (options.resumeAgentId) {
    const currentSessionStatePath = sessionStateStorePath({
      repoRoot: options.repoRoot,
      conductorAgentId: conductorAgent.agentId,
      issueUrl: options.issueUrl,
      location: 'canonical-slug',
    });
    try {
      const currentState = await loadSessionStateStore(currentSessionStatePath);
      if (
        !currentState &&
        activeLocatedResumeStore &&
        resolvePath(activeLocatedResumeStore.resumeStore.repoRoot) !==
          resolvePath(options.repoRoot)
      ) {
        reportResumeNotice(
          '保存時 clone に残る legacy session-state YAML は通常読み取り対象ではありません。以前の statusLine と履歴を復元する必要がある場合は、migration tool で canonical slug へ移してください。',
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sessionLogger.emit({
        type: 'harness.warning',
        message: `Issue 保存先の session state を読み込めませんでした。 error=${detail}`,
      });
      reportResumeNotice(
        `Issue 保存先の session-state YAML を読み込めませんでした。原因: ${detail}`,
      );
    }
  }
  const conductorHandle: ConductorAgentHandle = { conductor: conductorAgent };
  await ownershipLifecycle.acquireGlobal(conductorAgent.agentId);
  activeResumeStorePath ??= canonicalSessionResumeStorePath({
    repoRoot: options.repoRoot,
    issueUrl: options.issueUrl,
    conductorAgentId: conductorAgent.agentId,
  });
  // Keep auth/transport reconnects on the same backend factory as the session.
  const sendReconnect = {
    conductorAgentFactory,
    conductorOptions,
    retrySuppressionSignal: shutdownIntentController.signal,
    onAuthReconnectAttempt: ({
      agentId,
      source,
    }: {
      agentId: string;
      source?: 'automatic' | 'manual';
    }) => {
      sessionLogger.emit({
        type: 'conductor.auth.reconnect',
        agentId,
        status: 'attempt',
        ...(source ? { source } : {}),
      });
    },
    onAuthReconnectComplete: ({
      agentId,
      success,
      source,
      closeFailed,
    }: {
      agentId: string;
      success: boolean;
      source?: 'automatic' | 'manual';
      closeFailed?: boolean;
    }) => {
      sessionLogger.emit({
        type: 'conductor.auth.reconnect',
        agentId,
        status: success ? 'succeeded' : 'failed',
        ...(source ? { source } : {}),
      });
      if (closeFailed) {
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            '旧 conductor の終了処理に失敗したため、リソース解放は確認できません。再接続後の状態を確認してください。',
        });
      }
    },
    onTransportReconnectAttempt: ({
      agentId,
      source,
    }: {
      agentId: string;
      source?: 'automatic' | 'manual';
    }) => {
      sessionLogger.emit({
        type: 'conductor.transport.reconnect',
        agentId,
        status: 'attempt',
        ...(source ? { source } : {}),
      });
    },
    onTransportReconnectComplete: ({
      agentId,
      success,
      source,
      closeFailed,
    }: {
      agentId: string;
      success: boolean;
      source?: 'automatic' | 'manual';
      closeFailed?: boolean;
    }) => {
      sessionLogger.emit({
        type: 'conductor.transport.reconnect',
        agentId,
        status: success ? 'succeeded' : 'failed',
        ...(source ? { source } : {}),
      });
      if (closeFailed) {
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            '旧 conductor の終了処理に失敗したため、リソース解放は確認できません。再接続後の状態を確認してください。',
        });
      }
    },
  };

  let sessionResumeStoreWriteQueue: Promise<void> = Promise.resolve();
  let recoverySaveUncertain = false;
  drainStartupResumeStoreWrites = async () => {
    await sessionResumeStoreWriteQueue;
  };
  let terminalLifecycle: SessionLifecycle | undefined;
  let terminalResumeStoreFinalFlushQueued = false;
  const enqueueSessionResumeStoreWrite = (
    write: (lease: SessionWriteLease, resourceLease: SessionWriteLease) => Promise<void>,
  ): Promise<void> => {
    const previousWrite = sessionResumeStoreWriteQueue;
    const nextWrite = ownershipLifecycle.get().runJointWrite(ownershipLifecycle.getProvider(), (lease, resourceLease) =>
      previousWrite.then(() => write(lease, resourceLease)));
    sessionResumeStoreWriteQueue = nextWrite.catch(() => {});
    return nextWrite;
  };
  const createSessionResumeStore = (
    snapshot: OpenQuestionRegistrySnapshot,
    lifecycle?: SessionLifecycle,
  ): SessionResumeStore => {
    const workers: SessionResumeStore['workers'] = {};
    for (const [name, worker] of workerSessions) {
      workers[name] = {
        ...worker,
        ...(workerSessionOrigins.get(name) ?? { repoRoot: options.repoRoot, issueUrl: options.issueUrl }),
      };
    }
    const persistedLifecycle =
      terminalLifecycle ??
      lifecycle ??
      (harnessPhase === 'running' || harnessPhase === 'idle'
        ? 'unknown'
        : undefined);
    const cursorBootstrapComplete = cursorBootstrapState
      ? cursorBootstrapCompleteForStore(cursorBootstrapState)
      : undefined;
    return {
      version: activeResumeStoreVersion === WORKSPACE_RENAME_SESSION_RESUME_STORE_VERSION ||
        Object.values(workers).some((worker) => worker.recreateRequired)
        ? WORKSPACE_RENAME_SESSION_RESUME_STORE_VERSION
        : SESSION_RESUME_STORE_VERSION,
      conductorAgentId: conductorHandle.conductor.agentId,
      conductorBackend,
      ...(createdHarnessCliVersion !== undefined
        ? { createdHarnessCliVersion }
        : {}),
      conductorCwd,
      ...(cursorBootstrapRunId
        ? { cursorBootstrapRunId }
        : {}),
      ...(cursorBootstrapComplete !== undefined
        ? { cursorBootstrapComplete }
        : {}),
      lazyWorkers: activeLazyWorkers,
      ...(harnessSocketPath ? { harnessSocketPath } : {}),
      issueUrl: options.issueUrl,
      repoRoot: options.repoRoot,
      profile: structuredClone(activeProfile),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      ...(harnessPhase ? { harnessPhase } : {}),
      ...(harnessModifiedAt !== undefined
        ? { modifiedAt: harnessModifiedAt }
        : {}),
      openQuestions: snapshot.openQuestions,
      sequence: snapshot.sequence,
      workers,
      mcpConfigDigest,
      ...(ensembleConfigDigestScheme !== undefined
        ? { ensembleConfigDigestScheme }
        : {}),
      ...(ensembleConfigDigest !== undefined
        ? { ensembleConfigDigest }
        : {}),
      ...(acpModelConfigDigest !== undefined
        ? { acpModelConfigDigest }
        : {}),
      ...(persistedLifecycle ? { lifecycle: persistedLifecycle } : {}),
      ...(githubMonitorCursor ? { githubMonitor: githubMonitorCursor } : {}),
      updatedAt: Date.now(),
    };
  };
  const persistOpenQuestionsSnapshot = async (
    snapshot: OpenQuestionRegistrySnapshot,
    lease: SessionWriteLease,
  ): Promise<void> => {
    await saveOpenQuestionsStore(
      openQuestionsStorePath({
        repoRoot: options.repoRoot,
        conductorAgentId: conductorHandle.conductor.agentId,
        issueUrl: options.issueUrl,
        location: 'canonical-slug',
      }),
      snapshot,
      ownershipLifecycle.getProvider(),
      lease,
    );
  };
  const persistSessionResumeStore = async (
    snapshot: OpenQuestionRegistrySnapshot,
    lease: SessionWriteLease,
    lifecycle?: SessionLifecycle,
  ): Promise<void> => {
    await saveSessionResumeStore(
      activeResumeStorePath!,
      createSessionResumeStore(snapshot, lifecycle),
      ownershipLifecycle.get(),
      lease,
    );
  };
  commitWorkerSessionId = (notification) =>
    enqueueSessionResumeStoreWrite(async (lease) => {
      if (terminalResumeStoreFinalFlushQueued || teardownStarted || recoverySaveUncertain) {
        throw new Error('Cannot save a worker session ID during shutdown or an uncertain save.');
      }
      const previous = workerSessions.get(notification.name);
      if (previous && previous.acpSessionId !== notification.acpSessionId) {
        throw new Error(
          `Worker "${notification.name}" session changed before its ID could be saved; inspect the saved state before retrying.`,
        );
      }
      const origin = workerSessionOrigins.get(notification.name) ?? {
        repoRoot: options.repoRoot,
        issueUrl: options.issueUrl,
      };
      const fingerprint = workerAcpFingerprints.get(notification.name);
      const replacement: WorkerSessionResumeStore = {
        ...previous,
        acpSessionId: notification.acpSessionId,
        acpCwd: notification.acpCwd,
        ...(!previous?.originAcpCwd
          ? { originAcpCwd: notification.acpCwd }
          : {}),
        ...(!previous?.originAcpSpawn && fingerprint
          ? { originAcpSpawn: historySpawnFingerprint(fingerprint) }
          : {}),
        ...(fingerprint ? { acpSpawn: fingerprint } : {}),
        ...origin,
      };
      const snapshot = createSessionResumeStore(openQuestions.snapshot());
      snapshot.workers[notification.name] = replacement;
      try {
        await saveSessionResumeStore(activeResumeStorePath!, snapshot, ownershipLifecycle.get(), lease);
      } catch (error) {
        // A first lazy attach has no previously durable ID to fall back to.
        // Keep later flushes from overwriting a possibly renamed snapshot.
        if (!previous) {
          recoverySaveUncertain = true;
          shutdownIntentController.abort();
          operatorTerminationController.abort();
          workerSession.runtime.cancelAllActivePrompts();
        }
        throw new Error(
          `Worker "${notification.name}" ACP session ID could not be saved; the previous saved session ID was retained.`,
          { cause: error },
        );
      }
      workerSessions.set(notification.name, replacement);
      workerSessionOrigins.set(notification.name, origin);
    });
  commitWorkerSessionRecovery = (notification) =>
    enqueueSessionResumeStoreWrite(async (lease) => {
      if (terminalResumeStoreFinalFlushQueued || teardownStarted) {
        throw new Error('Cannot commit worker session recovery during shutdown; resume the prior session.');
      }
      const previous = workerSessions.get(notification.name);
      if (!previous || previous.acpSessionId !== notification.previousSessionId) {
        throw new Error(`Worker "${notification.name}" session changed during recovery; inspect saved state before retrying.`);
      }
      const origin = workerSessionOrigins.get(notification.name) ?? {
        repoRoot: options.repoRoot,
        issueUrl: options.issueUrl,
      };
      const replacement: WorkerSessionResumeStore = {
        acpSessionId: notification.acpSessionId,
        acpCwd: notification.acpCwd,
        handoffPending: true,
        ...(workspaceSession ? { workspacePromptVersion: WORKSPACE_WORKER_PROMPT_VERSION } : {}),
        originAcpCwd: notification.acpCwd,
        repoRoot: options.repoRoot,
        issueUrl: options.issueUrl,
        ...(workerAcpFingerprints.get(notification.name)
          ? {
              acpSpawn: workerAcpFingerprints.get(notification.name),
              originAcpSpawn: historySpawnFingerprint(workerAcpFingerprints.get(notification.name)!),
            }
          : {}),
        generations: [
          ...(previous.generations ?? []),
          {
            acpSessionId: previous.acpSessionId,
            ...(previous.originAcpCwd ?? previous.acpCwd
              ? { acpCwd: previous.originAcpCwd ?? previous.acpCwd }
              : {}),
            ...(previous.originAcpSpawn ?? previous.acpSpawn
              ? { acpSpawn: historySpawnFingerprint((previous.originAcpSpawn ?? previous.acpSpawn)!) }
              : {}),
            ...origin,
            replacedAt: Date.now(),
            reason: notification.reason,
            nextSessionId: notification.acpSessionId,
          },
        ],
      };
      const snapshot = createSessionResumeStore(openQuestions.snapshot());
      snapshot.workers[notification.name] = replacement;
      try {
        await saveSessionResumeStore(activeResumeStorePath!, snapshot, ownershipLifecycle.get(), lease);
      } catch (error) {
        recoverySaveUncertain = true;
        shutdownIntentController.abort();
        operatorTerminationController.abort();
        workerSession.runtime.cancelAllActivePrompts();
        throw new Error(
          'Worker session switch could not be confirmed. Stop this session, inspect the saved worker ID and generation history, and resume from the saved state.',
          { cause: error },
        );
      }
      workerSessions.set(notification.name, replacement);
      workerSessionOrigins.set(notification.name, { repoRoot: options.repoRoot, issueUrl: options.issueUrl });
    });
  commitWorkerHandoffConfirmed = (name, sessionId) => enqueueSessionResumeStoreWrite(async (lease) => {
    if (terminalResumeStoreFinalFlushQueued || teardownStarted || recoverySaveUncertain) {
      throw new Error('Cannot confirm worker handoff during shutdown or an uncertain save.');
    }
    const previous = workerSessions.get(name);
    if (!previous?.handoffPending || previous.acpSessionId !== sessionId) throw new Error(`Worker "${name}" has no saved pending handoff for the expected session.`);
    const replacement = { ...previous, handoffPending: false };
    const snapshot = createSessionResumeStore(openQuestions.snapshot());
    snapshot.workers[name] = replacement;
    try {
      await saveSessionResumeStore(activeResumeStorePath!, snapshot, ownershipLifecycle.get(), lease);
    } catch (error) {
      recoverySaveUncertain = true;
      shutdownIntentController.abort();
      operatorTerminationController.abort();
      workerSession.runtime.cancelAllActivePrompts();
      throw new Error('Handoff confirmation outcome is unknown. Stop and inspect the saved session before retrying.', { cause: error });
    }
    workerSessions.set(name, replacement);
  });
  flushSessionResumeStore = (lifecycle): Promise<void> => {
    if (terminalResumeStoreFinalFlushQueued && lifecycle === undefined) {
      return sessionResumeStoreWriteQueue;
    }
    if (lifecycle !== undefined && lifecycle !== 'unknown') {
      terminalResumeStoreFinalFlushQueued = true;
    }
    return enqueueSessionResumeStoreWrite(async (lease, resourceLease) => {
      if (recoverySaveUncertain) {
        throw new Error('Worker session switch outcome is unknown; refusing to overwrite the saved state.');
      }
      if (lifecycle !== undefined) {
        terminalLifecycle = lifecycle;
        harnessPhase =
          lifecycle === 'closed'
            ? 'close'
            : lifecycle === 'exited'
              ? 'exit'
              : lifecycle === 'interrupted'
                ? 'abort'
                : undefined;
        harnessModifiedAt = harnessPhase ? Date.now() : undefined;
      }
      const snapshot = openQuestions.snapshot();
      await persistOpenQuestionsSnapshot(snapshot, resourceLease);
      await persistSessionResumeStore(snapshot, lease, lifecycle);
    });
  };
  const reportResumeStoreFlushFailure = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    sessionLogger.emit({
      type: 'harness.warning',
      message:
        `Open Question YAML / SessionResumeStore を保存できませんでした。最新状態から再開できず、直前に保存された状態からの再開になる場合があります。 error=${detail}`,
    });
  };
  const reportSessionResumeStoreWriteFailure = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    sessionLogger.emit({
      type: 'harness.warning',
      message:
        `SessionResumeStore の更新に失敗しました。Open Question YAML の保存は完了しており、保存状態は後続 flush で同期します。 error=${detail}`,
    });
  };
  scheduleSessionResumeStoreFlush = () => {
    void flushSessionResumeStore().catch(reportResumeStoreFlushFailure);
  };
  let conductorSendCount = 0;
  let workerPromptCount = 0;
  let idlePhaseTimer: ReturnType<typeof setTimeout> | undefined;
  const persistHarnessPhase = (phase: HarnessPhase | undefined): void => {
    if (teardownStarted || harnessPhase === phase) return;
    if (idlePhaseTimer) {
      clearTimeout(idlePhaseTimer);
      idlePhaseTimer = undefined;
    }
    harnessPhase = phase;
    harnessModifiedAt = Date.now();
    void flushSessionResumeStore().catch(reportResumeStoreFlushFailure);
  };
  reportHarnessActivity = (kind, active) => {
    if (teardownStarted) return;
    if (kind === 'conductor') {
      conductorSendCount = Math.max(0, conductorSendCount + (active ? 1 : -1));
    } else {
      workerPromptCount = Math.max(0, workerPromptCount + (active ? 1 : -1));
    }
    if (conductorSendCount + workerPromptCount > 0) {
      persistHarnessPhase('running');
      return;
    }
    if (idlePhaseTimer || harnessPhase === 'idle') return;
    idlePhaseTimer = setTimeout(() => {
      idlePhaseTimer = undefined;
      if (conductorSendCount + workerPromptCount === 0) {
        persistHarnessPhase('idle');
      }
    }, 250);
    idlePhaseTimer.unref?.();
  };
  const toolCallHistoryPath = toolCallSnapshotHistoryPath({
    repoRoot: options.repoRoot,
    conductorAgentId: conductorHandle.conductor.agentId,
    issueUrl: options.issueUrl,
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
    const owner = ownershipLifecycle.getProvider();
    const previousFlush = toolCallHistoryFlushQueue;
    const nextFlush = owner.runWrite((lease) => previousFlush.then(() =>
      saveToolCallSnapshotHistory(toolCallHistoryPath, toolCallSnapshots.snapshot(), owner, lease),
    ));
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
  let sendCount = 0;
  let autonomousTurns = 0;

  const monitorDefaults = ensembleConfig.github.monitor;
  if (
    !workspaceSession &&
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
        scheduleSessionResumeStoreFlush();
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
    startupCleanup.add(async () => {
      await githubMonitor?.stop();
    });
    githubMonitor.start();
  }

  dispatchHoldReminderMonitor = createDispatchHoldReminderMonitor({
    getSnapshot: () => ({
      hold: dispatchHoldState.dispatchHold,
      heldEventCount: dispatchHoldState.heldEvents.length,
    }),
    onReminder: ({ heldEventCount }) => {
      sessionLogger.emit({
        type: 'harness.warning',
        message: formatDispatchHoldReminderMessage(
          heldEventCount,
          options.dispatchHoldReminderMs,
        ),
      });
    },
    reminderIntervalMs: options.dispatchHoldReminderMs,
    shutdownSignal,
  });
  startupCleanup.add(() => dispatchHoldReminderMonitor!.stop());
  dispatchHoldReminderMonitor.start();

  let permissionDeadlockMonitor: PermissionDeadlockMonitor | undefined;
  if (!options.disablePermissionDeadlockMonitor) {
    permissionDeadlockMonitor = createPermissionDeadlockMonitor({
      pipeline: permissionPipeline,
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
    startupCleanup.add(() => permissionDeadlockMonitor!.stop());
    permissionDeadlockMonitor.start();
  }

  let stopReason: IssueLoopStopReason = 'completed';
  const continueOnConductorError = options.continueOnConductorError ?? false;
  const waitForOperatorExit = options.waitForOperatorExit ?? false;
  const operatorCanInspectRecovery =
    options.operatorCanInspectRecovery === true;
  let operatorRequestedExit = false;
  let operatorRequestedClose = false;
  let disposeOperatorInput: (() => void) | undefined;
  const resolveCursorBootstrapUnknown = (
    assumption: CursorBootstrapAssumption,
  ): boolean => {
    if (
      !operatorCanInspectRecovery ||
      !cursorBootstrapState ||
      cursorBootstrapState.status !== 'unknown'
    ) {
      return false;
    }
    cursorBootstrapState.status = 'saving';
    cursorBootstrapState.pendingAssumption = assumption;
    void flushSessionResumeStore()
      .then(() => {
        cursorBootstrapState.status =
          assumption === 'assume-complete' ? 'complete' : 'incomplete';
        delete cursorBootstrapState.pendingAssumption;
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            assumption === 'assume-complete'
              ? 'operator が Cursor bootstrap を complete と仮定する判断を SessionResumeStore に保存しました。compiled prompt は追加送信しません。'
              : 'operator が Cursor bootstrap を incomplete と仮定する判断を SessionResumeStore に保存しました。次の新しい event に compiled prompt を添えて送ります。',
        });
      })
      .catch((error: unknown) => {
        cursorBootstrapState.status = 'unknown';
        delete cursorBootstrapState.pendingAssumption;
        reportResumeStoreFlushFailure(error);
      })
      .finally(() => dispatchLifecycle.wake());
    return true;
  };

  const onOperatorMessageQueued = (delivery: OperatorMessageDelivery): void => {
    scheduleSessionResumeStoreFlush();
    if (delivery !== 'interrupt') return;

    const cancel = conductorHandle.conductor.cancel;
    if (!cancel) {
      sessionLogger.emit({
        type: 'harness.warning',
        message:
          'Operator interrupt cancellation is unavailable; the message will use normal next dispatch.',
      });
      return;
    }
    void cancel.call(conductorHandle.conductor).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      sessionLogger.emit({
        type: 'harness.warning',
        message:
          `Operator interrupt cancellation failed; the message will use normal next dispatch: ${detail}`,
      });
    });
  };

  const submitOperatorMessage = (input: {
    message: string;
    delivery?: OperatorMessageDelivery;
    targetOpenQuestionId?: string;
    answeredAt?: number;
    onEscalated?: (record: EscalationRecord) => void;
    onOperatorMessageQueued?: (event: OperatorMessageEvent) => void;
  }): boolean => {
    const delivery = input.delivery ?? 'next';
    const received = submitOperatorInput({
      ...input,
      delivery,
      conductorTurn: sendCount + 1,
      openQuestions,
      escalations,
      eventQueue,
      sessionLogger,
      onEscalated:
        input.onEscalated ?? ((record) => options.onEscalated?.(record)),
    });
    if (!received) return false;
    onOperatorMessageQueued(delivery);
    return true;
  };

  const sendOperatorMessage = (input: {
    message: string;
    delivery?: OperatorMessageDelivery;
  }): boolean => {
    const delivery = input.delivery ?? 'next';
    const received = enqueueOperatorMessageEvent({
      ...input,
      delivery,
      conductorTurn: sendCount + 1,
      eventQueue,
      sessionLogger,
    });
    if (!received) return false;
    onOperatorMessageQueued(delivery);
    return true;
  };

  const requestOperatorShutdown = (
    mode: OperatorSessionShutdownMode,
  ): boolean => {
    if (teardownStarted || operatorRequestedExit || operatorRequestedClose) {
      return false;
    }

    if (mode === 'exit') {
      sessionLogger.emit({ type: 'session.operator_exit' });
      workerSession.runtime.cancelAllActivePrompts();
      operatorRequestedExit = true;
    } else {
      sessionLogger.emit({ type: 'session.operator_close' });
      workerSession.runtime.cancelAllActivePrompts();
      operatorRequestedClose = true;
    }
    shutdownIntentController.abort();
    abortAfterOpenQuestionDrain(operatorTerminationController);
    return true;
  };

  if (options.bindOperatorInput) {
    const continueAfterRecovery = (expectedAttemptId?: string): boolean => {
      const gatedAttempt = dispatchLifecycle.pendingAttemptId;
      const attempt = gatedAttempt ?? unconfirmedWorkerFailures.keys().next().value;
      if (!attempt || (expectedAttemptId !== undefined && expectedAttemptId !== attempt)) return false;
      if (gatedAttempt) {
        if (!dispatchLifecycle.confirmRecovery(attempt)) return false;
      } else if (dispatchLifecycle.state === 'in_flight' || dispatchLifecycle.state === 'reconnecting') {
        return false;
      }
      for (const id of unconfirmedWorkerFailures.get(attempt) ?? []) pendingWorkerFailures.delete(id);
      unconfirmedWorkerFailures.delete(attempt);
      return true;
    };
    const bindingDispose = options.bindOperatorInput({
      submit: (message, submitOptions) => {
        if (submitOptions?.targetOpenQuestionId !== undefined) {
          return submitOperatorMessage({
            message,
            delivery: 'next',
            targetOpenQuestionId: submitOptions.targetOpenQuestionId,
          });
        }
        if (isOperatorExitCommand(message)) {
          requestOperatorShutdown('exit');
          return false;
        }
        if (isOperatorCloseCommand(message)) {
          requestOperatorShutdown('close');
          return false;
        }
        if (isOperatorReconnectCommand(message)) {
          eventQueue.enqueue({ type: 'operator.reconnect' });
          return true;
        }
        const parsed =
          submitOptions?.delivery === undefined
            ? parseOperatorMessageDelivery(message)
            : { message, delivery: submitOptions.delivery };
        return submitOperatorMessage({
          message: parsed.message,
          delivery: parsed.delivery,
          targetOpenQuestionId: submitOptions?.targetOpenQuestionId,
        });
      },
      getContext: () => ({
        conductorTurn: sendCount + 1,
        autonomousTurns,
        maxTurns: operatorInputMaxTurns(maxTurns),
        openQuestions: openQuestions.listOpen(),
        queuedMessages: eventQueue.snapshot().flatMap((event) =>
          event.type === 'operator.message'
            ? [{
                text: event.text,
                delivery: event.delivery ?? 'next',
                openQuestionAnswer: event.openQuestionAnswer === true,
                ...(event.answerPreview ? { answerPreview: event.answerPreview } : {}),
              }]
            : [],
        ),
      }),
      listRecoverySnapshots: () => recoveryInbox.list(),
      ...(operatorCanInspectRecovery
        ? {
            getRecoverySnapshot: (recoveryId: string) =>
              recoveryInbox.get(recoveryId),
          }
        : {}),
      clearRecoverySnapshot: (recoveryId) => recoveryInbox.remove(recoveryId),
      continueAfterRecovery: () => continueAfterRecovery(),
      continueAfterRecoveryForAttempt: (attemptId) => continueAfterRecovery(attemptId),
      recoveryAttentionAttemptId: () =>
        dispatchLifecycle.pendingAttemptId ?? unconfirmedWorkerFailures.keys().next().value,
      ...(cursorBootstrapState && operatorCanInspectRecovery
        ? {
            getCursorBootstrapStatus: () => cursorBootstrapState.status,
            resolveCursorBootstrapUnknown,
          }
        : {}),
    });
    if (typeof bindingDispose === 'function') {
      disposeOperatorInput = bindingDispose;
      startupCleanup.add(() => disposeOperatorInput?.());
    }
  }

  try {
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
    const secretCliReady =
      isOneTimeSecretPlatformSupported() &&
      !options.connectAcp &&
      options.secretCliEntrypoint !== undefined &&
      isAbsolute(options.secretCliEntrypoint) &&
      (await pathExists(options.secretCliEntrypoint).catch(() => false));
    if (secretCliReady) {
      for (const worker of workers) {
        const preset = worker.acpFingerprint?.preset;
        if (!preset || !isBuiltinAcpPresetId(preset)) continue;
        secretWorkerTokens.set(
          worker.name,
          randomBytes(32).toString('base64url'),
        );
      }
    }
    if (secretWorkerTokens.size > 0) {
      try {
        oneTimeSecretControlServer =
          await startOneTimeSecretControlServer({
            workerTokens: secretWorkerTokens,
            onRequest: (request) =>
              sessionLogger.emit({
                type: 'worker.secret.requested',
                ...request,
              }),
          });
        startupCleanup.add(async () => {
          await oneTimeSecretControlServer?.close();
          clearOneTimeSecretWorkerEnvironment(workers);
          secretWorkerTokens.clear();
        });
      } catch {
        secretWorkerTokens.clear();
        sessionLogger.emit({
          type: 'harness.warning',
          message:
            'One-time secret IPC is unavailable; secret exec will fail closed for this session.',
        });
      }
    }
    configureOneTimeSecretWorkerEnvironment({
      workers,
      workerTokens: secretWorkerTokens,
      socketPath: oneTimeSecretControlServer?.socketPath,
      cliEntrypoint: options.secretCliEntrypoint,
    });
    for (const worker of workers) {
      const env = worker.spawn!.env!;
      delete env.ENSEMBLE_WORKSPACE_SLUG;
      delete env.ENSEMBLE_WORKSPACE_REPO_ROOT;
      delete env.ENSEMBLE_WORKSPACE_CONDUCTOR_CWD;
      if (workspaceSession) {
        env.ENSEMBLE_WORKSPACE_SLUG = workspaceSession.slugKey;
        env.ENSEMBLE_WORKSPACE_REPO_ROOT = resolvePath(options.repoRoot);
        env.ENSEMBLE_WORKSPACE_CONDUCTOR_CWD = resolvePath(conductorCwd);
      }
    }
    // Keep startup cleanup active through startup logging and the final
    // shutdown check. No await follows this check before workers start.
    shutdownSignal.throwIfAborted();
    startupCleanup.handoff();
    workerSession.startWorkers();
    for (const [name, saved] of workerSessions) {
      if (!saved.handoffPending && !saved.recreateRequired) continue;
      const worker = activeProfile.workers.find((entry) => entry.name === name);
      if (!worker) continue;
      eventQueue.enqueue({
        type: 'worker.session.recovered',
        name,
        kind: worker.kind,
        reason: saved.generations?.at(-1)?.reason ?? 'explicit',
        ...(saved.recreateRequired ? { recreateRequired: true } : {}),
      });
    }
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
    if (toolCallHistoryDirty) scheduleToolCallHistoryFlush();

    openQuestionControlServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => openQuestions.listOpen(),
      getLastConductorMessage: () => lastConductorMessage,
      listConductorMessages: () => conductorMessages,
      observeSession: async () => {
        await sessionStateWriteQueue;
        const currentStatePath = sessionStateStorePath({
          repoRoot: options.repoRoot,
          conductorAgentId: conductorAgent.agentId,
          issueUrl: options.issueUrl,
          location: 'canonical-slug',
        });
        const sessionState = await loadSessionStateStore(currentStatePath);
        const pendingWorkerIds = new Set(
          permissionPipeline.pending.list().map((permission) => permission.workerId),
        );
        const runningIdsByName = new Map(
          workerSession.runtime.listRunning().map((worker) => [worker.name, worker.workerId]),
        );
        const workers = workerSession.runtime.listWorkerStatuses().map((worker) => ({
          state: worker.state,
          queueDepth: worker.queueDepth,
          permissionPending: pendingWorkerIds.has(runningIdsByName.get(worker.name) ?? ''),
        }));
        return {
          ...openQuestions.snapshot(),
          ...(sessionState ? { sessionState } : {}),
          workStatus: classifySessionWorkStatus({
            conductorSending: conductorSendCount > 0,
            workers,
            shuttingDown: teardownStarted,
            pendingWorkerFailures: pendingWorkerFailures.size > 0,
            unresolvedPermissions:
              workerSession.inbox.pendingPermissionCount !== permissionPipeline.pending.size,
          }),
        };
      },
      sendOperatorMessage: ({ text, delivery }) => {
        if (teardownStarted) {
          throw new OpenQuestionControlOperationError(
            -32000,
            'The session is shutting down.',
          );
        }
        return sendOperatorMessage({ message: text, delivery });
      },
      requestOperatorShutdown: ({ mode }) =>
        requestOperatorShutdown(mode),
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
        let accepted = false;
        let resumeStoreWriteError: unknown;
        let dispatchReceipt: Promise<void> | undefined;
        let answered: OpenQuestion | undefined;
        const escalatedRecords: EscalationRecord[] = [];

        await enqueueSessionResumeStoreWrite(async (lease, resourceLease) => {
          const stagedOpenQuestions = new OpenQuestionRegistry();
          stagedOpenQuestions.restore(openQuestions.snapshot());
          const stagedAccepted = submitOperatorInput({
            message: answer,
            targetOpenQuestionId: questionId,
            conductorTurn: sendCount + 1,
            openQuestions: stagedOpenQuestions,
            escalations: [],
            eventQueue: new SessionEventQueue(),
            sessionLogger: { emit: () => {} },
          });
          const stagedAnswer = stagedOpenQuestions.get(questionId);
          if (
            !stagedAccepted ||
            !stagedAnswer ||
            stagedAnswer.status !== 'answered'
          ) {
            return;
          }

          // The Open Questions YAML is the durable commit point. Do not expose
          // the answer in the live Registry or event queue until this succeeds.
          await persistOpenQuestionsSnapshot(stagedOpenQuestions.snapshot(), resourceLease);

          // Another answer path may have won while the atomic YAML write was
          // in flight. Restore the current Registry snapshot before rejecting.
          if (openQuestions.get(questionId)?.status !== 'open') {
            await persistOpenQuestionsSnapshot(openQuestions.snapshot(), resourceLease);
            return;
          }

          accepted = submitOperatorMessage({
            message: answer,
            delivery: 'next',
            targetOpenQuestionId: questionId,
            answeredAt: stagedAnswer.answeredAt,
            onEscalated: (record) => escalatedRecords.push(record),
            onOperatorMessageQueued: (event) => {
              let receipt!: {
                resolve: () => void;
                reject: (error: Error) => void;
              };
              dispatchReceipt = new Promise<void>((resolve, reject) => {
                receipt = {
                  resolve: () => resolve(),
                  reject: (error) => reject(error),
                };
                openQuestionDispatchReceipts.set(event, receipt);
                pendingOpenQuestionDispatchReceipts.add(receipt);
              });
              void dispatchReceipt.catch(() => {});
            },
          });
          answered = openQuestions.get(questionId);
          if (!accepted || !answered || answered.status !== 'answered') {
            await persistOpenQuestionsSnapshot(openQuestions.snapshot(), resourceLease);
            accepted = false;
            return;
          }

          try {
            await persistSessionResumeStore(openQuestions.snapshot(), lease);
          } catch (error) {
            // YAML is authoritative and is already durable. Keep the accepted
            // answer/notification, report the mirror failure, then repair it.
            resumeStoreWriteError = error;
          }
        });
        if (!accepted || !answered || answered.status !== 'answered') {
          throw new OpenQuestionControlOperationError(
            -32004,
            'Open Question could not be answered.',
          );
        }
        for (const record of escalatedRecords) {
          try {
            options.onEscalated?.(record);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            sessionLogger.emit({
              type: 'harness.warning',
              message: `Open Question observer callback failed: ${detail}`,
            });
          }
        }
        if (resumeStoreWriteError !== undefined) {
          reportSessionResumeStoreWriteFailure(resumeStoreWriteError);
          scheduleSessionResumeStoreFlush();
        }
        if (!dispatchReceipt) {
          throw new OpenQuestionControlOperationError(
            -32603,
            'The answer was recorded, but its conductor notification was not queued. The outcome is unknown; do not resubmit the answer and inspect the session state.',
            RECORDED_ANSWER_UNKNOWN_DISPATCH,
          );
        }
        await dispatchReceipt;
        return answered;
      },
    });
    harnessSocketPath = openQuestionControlServer.socketPath;
    await flushSessionResumeStore().catch(reportResumeStoreFlushFailure);

    const driverResult = await runConductorSessionDriver({
      issueUrl: options.issueUrl,
      initialPrompt:
        conductorBackend === 'pi'
          ? workspaceSession
            ? createWorkspacePiKickoffPrompt(
                workspaceSession.slugKey,
                options.briefText,
              )
            : createPiKickoffPrompt(options.issueUrl)
          : systemPrompt,
      conductorHandle,
      sendReconnect,
      eventQueue,
      recoveryInbox,
      recoveryBackend: conductorBackend,
      dispatchLifecycle,
      operatorCanInspectRecovery,
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
      onOperatorQueueChanged: () => {
        sessionLogger.emit({ type: 'operator.queue.changed' });
      },
      onWorkerFailuresDelivered: (events) => {
        for (const event of events) {
          if (event.type !== 'worker.failed') continue;
          const id = workerFailureIds.get(event.failure);
          if (id !== undefined) {
            pendingWorkerFailures.delete(id);
            for (const [attempt, failures] of unconfirmedWorkerFailures) {
              failures.delete(id);
              if (failures.size === 0) unconfirmedWorkerFailures.delete(attempt);
            }
          }
        }
      },
      onWorkerFailuresUnconfirmed: (attempt, events) => {
        const failures = new Set<number>();
        for (const event of events) {
          if (event.type !== 'worker.failed') continue;
          const id = workerFailureIds.get(event.failure);
          if (id !== undefined) failures.add(id);
        }
        if (failures.size > 0) unconfirmedWorkerFailures.set(attempt, failures);
      },
      onOperatorDispatched: (events) => {
        for (const event of events) {
          if (event.type === 'operator.message') {
            sessionLogger.emit({ type: 'operator.dispatched', text: event.text });
          }
        }
      },
      // Agent.resume already retains the conductor conversation. Worker
      // startup happens before the driver, so resume events (including
      // permission.pending) must be dispatched without waiting for a new
      // session briefing.
      skipInitialSend: Boolean(options.resumeAgentId),
      ...(cursorBootstrapState ? { cursorBootstrapState } : {}),
      onSendStarted: (info) => {
        reportHarnessActivity('conductor', true);
        sessionLogger.emit({
          type: 'conductor.send.started',
          sendCount: info.sendCount,
          dispatchSource: info.dispatchSource,
        });
      },
      onOutputPhase: (phase) => sessionLogger.emit({ type: 'conductor.output_phase', phase }),
      onSendProgress: (info) => {
        sessionLogger.emit({
          type: 'conductor.send.progress',
          sendCount: info.sendCount,
          runId: info.runId,
          tool: info.tool,
        });
      },
      onSendComplete: recordSendComplete,
      onRecoveryAttention: ({
        attemptId,
        sourceKey,
        status,
        failureClass,
        confirmationRequired,
        pendingOperatorMessageCount,
        snapshot,
        agentAvailable,
      }) => {
        const recoveryAction = operatorCanInspectRecovery
          ? snapshot
            ? `入力を確認するには /recovery list の後に /recovery show ${snapshot.recoveryId} を実行してください。`
            : 'この send に operator-authored input は含まれていません。'
          : 'この実行環境では recovery 本文を確認できません。同一 process 内でも取得できず、process 終了時に破棄されます。';
        const queueNotice =
          pendingOperatorMessageCount > 0
            ? operatorCanInspectRecovery
              ? `未送信の operator message が ${pendingOperatorMessageCount} 件、既存 queue に残っています。`
              : `未送信の operator message ${pendingOperatorMessageCount} 件は既存 queue に残っていますが、非 TTY one-shot 終了時に破棄されます。必要なら状態を確認して再実行してください。`
            : undefined;
        const confirmationNotice = confirmationRequired
          ? operatorCanInspectRecovery
            ? '状態を確認してから必要な続きを新しい指示で送り、後続 dispatch を再開するには /recovery continue を実行してください。'
            : '失敗した入力は自動再送せず、後続 dispatch も停止しています。非 TTY では本文を確認できないため、状態を確かめてから安全な再開方法を判断してください。'
          : unconfirmedWorkerFailures.has(attemptId)
            ? '明示的な interrupt 入力を次に処理します。worker failure の通知結果は未確認です。/recovery list で attempt を確認し、/recovery continue で確認を記録してください。'
            : '明示的な interrupt 入力が queue に残っているため、その入力を次に処理します。/recovery continue は不要です。';
        sessionLogger.emit({
          type: 'harness.warning',
          message: [
            `conductor send が未完了です (source=${escapeTerminalControlCharacters(sourceKey)}, attempt=${attemptId}, status=${escapeTerminalControlCharacters(status)}, failure=${failureClass}).`,
            recoveryAction,
            queueNotice,
            agentAvailable
              ? undefined
              : 'agent は unavailable です。接続を直した後に /reconnect を実行してください。',
            confirmationNotice,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' '),
        });
      },
      onRecoveryCapacityBlocked: () => {
        sessionLogger.emit({
          type: 'harness.warning',
          message: operatorCanInspectRecovery
            ? 'recovery inbox の容量が上限に達しました。入力は queue に残して dispatch を待っています。/recovery clear <id> で空きを作るか、TTL 経過後に続行します。'
            : 'recovery inbox の容量が上限に達しました。入力を保持したまま dispatch を待っています。この実行環境では本文を確認できません。',
        });
      },
      onDispatchBatchSettled: ({ events, result, error }) => {
        for (const event of events) {
          if (event.type !== 'operator.message') continue;
          const receipt = openQuestionDispatchReceipts.get(event);
          if (!receipt) continue;
          openQuestionDispatchReceipts.delete(event);
          pendingOpenQuestionDispatchReceipts.delete(receipt);
          if (error || result?.status !== 'finished') {
            receipt.reject(
              new OpenQuestionControlOperationError(
                -32005,
                'The answer was recorded and persisted, but conductor notification could not be confirmed. The outcome is unknown; do not resubmit the answer and inspect the session state.',
                RECORDED_ANSWER_UNKNOWN_DISPATCH,
              ),
            );
          } else {
            receipt.resolve();
          }
        }
      },
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
      inbound: string;
      historyInbound?: string;
      dispatchSource?: string;
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
      if (
        conductorBackend === 'cursor' &&
        info.dispatchSource === 'initial' &&
        info.runId &&
        cursorBootstrapRunId === undefined
      ) {
        cursorBootstrapRunId = info.runId;
        scheduleSessionResumeStoreFlush();
      }
      const issueDispatchCompleted =
        info.status === 'finished' ||
        info.status === 'completed' ||
        info.status === 'running';
      if (
        conductorBackend === 'cursor' &&
        cursorBootstrapState?.status === 'incomplete' &&
        issueDispatchCompleted &&
        (info.dispatchSource === 'initial' || info.historyInbound !== undefined)
      ) {
        cursorBootstrapState.status = 'complete';
        scheduleSessionResumeStoreFlush();
      }
      const responseText = info.result?.trim();
      if (info.status === 'finished' && responseText) {
        const at = Date.now();
        lastConductorMessage = {
          text: responseText,
          at,
          sendCount: info.sendCount,
        };
        if (info.dispatchSource !== 'initial') {
          conductorMessages.push({
            text: responseText,
            inbound: info.historyInbound ?? info.inbound,
            at,
            sendCount: info.sendCount,
            ...(info.dispatchSource
              ? { dispatchSource: info.dispatchSource }
              : {}),
          });
          if (
            conductorMessages.length > CONDUCTOR_MESSAGE_HISTORY_MAX_ENTRIES
          ) {
            conductorMessages.shift();
          }
        }
      }
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
      reportHarnessActivity('conductor', false);
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
      scheduleSessionResumeStoreFlush();
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
        sessionModels: buildSessionModelsSummary({
          backend: conductorBackend,
          explicitConductorModelId: resolvedConductorModelId,
          explicitConductorReasoning: conductorReasoning,
          config: ensembleConfig,
          workers,
          usageTracker: sessionUsageTracker,
        }),
        sessionUsage:
          sessionUsage.totals.rounds > 0 ||
          sessionUsage.cost != null ||
          sessionUsage.compactionCount != null
            ? sessionUsage
            : undefined,
      });
    }
  } finally {
    disposeOperatorInput?.();
    disposeOperatorInput = undefined;
    recoveryInbox.dispose();
    const lifecycle: SessionLifecycle = operatorRequestedClose
      ? 'closed'
      : operatorRequestedExit
        ? 'exited'
        : shutdownSignal.aborted
          ? 'interrupted'
          : 'unknown';
    teardownStarted = true;
    if (idlePhaseTimer) {
      clearTimeout(idlePhaseTimer);
      idlePhaseTimer = undefined;
    }
    for (const receipt of pendingOpenQuestionDispatchReceipts) {
      receipt.reject(
        new OpenQuestionControlOperationError(
          -32005,
          'The answer was recorded and persisted, but the conductor session stopped before notification completed. The outcome is unknown; do not resubmit the answer and inspect the session state.',
          RECORDED_ANSWER_UNKNOWN_DISPATCH,
        ),
      );
    }
    pendingOpenQuestionDispatchReceipts.clear();
    const forceShutdown =
      operatorRequestedExit ||
      operatorRequestedClose ||
      shutdownSignal.aborted;
    const teardownStartedAt = Date.now();
    const teardownPhases: Record<string, number> = {};
    let teardownCompleted = false;
    let cleanupFailed = false;

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
      const activeSecretControlServer = oneTimeSecretControlServer;
      oneTimeSecretControlServer = undefined;
      if (activeSecretControlServer) {
        emitTeardownPhase('oneTimeSecretControl');
        const phaseStart = Date.now();
        try {
          await activeSecretControlServer.close();
        } catch {
          cleanupFailed = true;
          sessionLogger.emit({
            type: 'harness.warning',
            message: 'One-time secret IPC cleanup failed.',
          });
        }
        clearOneTimeSecretWorkerEnvironment(workers);
        secretWorkerTokens.clear();
        teardownPhases.oneTimeSecretControl = Date.now() - phaseStart;
      }
      const activeControlServer = openQuestionControlServer;
      openQuestionControlServer = undefined;
      harnessSocketPath = undefined;
      if (activeControlServer) {
        emitTeardownPhase('openQuestionControl');
        const phaseStart = Date.now();
        try {
          await activeControlServer.close();
        } catch (error) {
          cleanupFailed = true;
          const detail = error instanceof Error ? error.message : String(error);
          sessionLogger.emit({
            type: 'harness.warning',
            message: `Open Question control socket cleanup failed: ${detail}`,
          });
        }
        teardownPhases.openQuestionControl = Date.now() - phaseStart;
      }
      if (dispatchHoldReminderMonitor) {
        emitTeardownPhase('dispatchHoldReminderMonitor');
        dispatchHoldReminderMonitor.stop();
      }
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
        // A worker's ACP session exists before its first prompt completes, so
        // snapshot resumable attached sessions before force shutdown. Recovery
        // bootstrap replacements are excluded until initialized; their prior
        // workerSessions entry remains available for the next resume.
        for (const attached of workerSession.runtime.listAttachedForResume()) {
          const savedWorker = workerSessions.get(attached.name);
          if (savedWorker && savedWorker.acpSessionId !== attached.session.sessionId) continue;
          workerSessions.set(attached.name, {
            ...workerSessions.get(attached.name),
            acpSessionId: attached.session.sessionId,
            acpCwd: attached.session.acpCwd,
            ...(!savedWorker?.originAcpCwd ? { originAcpCwd: attached.session.acpCwd } : {}),
            ...(!savedWorker?.originAcpSpawn && workerAcpFingerprints.get(attached.name)
              ? { originAcpSpawn: historySpawnFingerprint(workerAcpFingerprints.get(attached.name)!) }
              : {}),
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
        emitTeardownPhase('flushSessionResumeStore');
        const phaseStart = Date.now();
        await flushSessionResumeStore();
        teardownPhases.flushSessionResumeStore = Date.now() - phaseStart;
      } catch (error) {
        reportResumeStoreFlushFailure(error);
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
        await closeConductorAgentOnce(conductorHandle.conductor, {
          forResume: operatorRequestedClose,
        });
        teardownPhases.conductor = Date.now() - phaseStart;
      };

      if (forceShutdown) {
        const results = await Promise.allSettled([
          runGithubMonitorStop(),
          runWorkerStop(),
          runConductorClose(),
        ]);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length) {
          throw new AggregateError(failures.map((failure) => failure.reason), 'Session shutdown failed or worker ACP shutdown is unconfirmed; ownership is retained until process exit; restart the owning process before resuming.');
        }
      } else {
        const failures: unknown[] = [];
        try {
          await runGithubMonitorStop();
        } catch (error) {
          failures.push(error);
        }
        // A monitor stop callback can synchronously dispatch a worker prompt.
        // Cancel that prompt before WorkerRuntime waits for idle and closes
        // the ACP bridge.
        workerSession.runtime.cancelAllActivePrompts();
        try {
          await runWorkerStop();
        } catch (error) {
          failures.push(error);
        }
        try {
          await runConductorClose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, 'Session shutdown failed or worker ACP shutdown is unconfirmed; ownership is retained until process exit; restart the owning process before resuming.');
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
      teardownCompleted = true;
    } finally {
      try {
        emitTeardownPhase('flushSessionResumeStore');
        await sessionStateWriteQueue;
        await flushSessionResumeStore(lifecycle);
      } catch (error) {
        cleanupFailed = true;
        reportResumeStoreFlushFailure(error);
      }
      process.off('SIGINT', onTeardownSignal);
      process.off('SIGTERM', onTeardownSignal);
      conductorFailureLog.close();
      if (teardownCompleted && !cleanupFailed) {
        ownershipLifecycle.markSafeToRelease();
      }
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
    result = await removeWorkerWorktree(repoRoot, worktree.path);
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
      sessionLogger.emit({
        type: 'harness.worktree.remove_failed',
        path: worktree.path,
        branch: worktree.branch,
        error: 'worktree not found in git worktree list',
      });
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
  repoRoot: string,
  issueNumber: number,
  defaultAcp?: DefaultAcpResolutionOptions,
  piAgentDir?: string,
  workspaceSlugKey?: string,
): void {
  const resolvedPiAgentDir =
    piAgentDir ??
    resolveConductorPiResourcePaths({
      repoRoot,
      config: defaultAcp?.config,
      env: defaultAcp?.env,
    }).agentDir;

  for (const worker of workers) {
    const resolved = resolveWorkerAcpSpawn({
      defaultOptions: defaultAcp,
      modelTag: worker.modelTag,
    });
    const sessionSpawn =
      resolved.piRuntime === 'builtin'
        ? configurePiWorkerRuntime(resolved, {
            repoRoot,
            workerName: worker.name,
            ...(workspaceSlugKey
              ? { workspaceSlugKey }
              : { issueNumber }),
            ...(resolvedPiAgentDir
              ? { agentDir: resolvedPiAgentDir }
              : {}),
          })
        : resolved;
    const finalized = finalizeResolvedAcpSpawn(sessionSpawn);
    worker.spawn = resolvedAcpSpawnToOptions(finalized, worker.spawn);
    worker.acpFingerprint = acpSpawnFingerprint(finalized);
  }
}

function configureOneTimeSecretWorkerEnvironment(input: {
  workers: SessionWorkerSpec[];
  workerTokens: ReadonlyMap<string, string>;
  socketPath?: string;
  cliEntrypoint?: string;
}): void {
  for (const worker of input.workers) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(worker.spawn?.env ?? {}),
    };
    for (const name of Object.values(ONE_TIME_SECRET_ENV)) {
      delete env[name];
    }

    const token = input.workerTokens.get(worker.name);
    if (token && input.socketPath && input.cliEntrypoint) {
      env[ONE_TIME_SECRET_ENV.active] = '1';
      env[ONE_TIME_SECRET_ENV.socket] = input.socketPath;
      env[ONE_TIME_SECRET_ENV.worker] = worker.name;
      env[ONE_TIME_SECRET_ENV.token] = token;
      env[ONE_TIME_SECRET_ENV.node] = process.execPath;
      env[ONE_TIME_SECRET_ENV.cli] = input.cliEntrypoint;
    }
    worker.spawn = {
      ...worker.spawn,
      env,
    };
  }
}

function clearOneTimeSecretWorkerEnvironment(
  workers: SessionWorkerSpec[],
): void {
  for (const worker of workers) {
    if (!worker.spawn?.env) continue;
    for (const name of Object.values(ONE_TIME_SECRET_ENV)) {
      delete worker.spawn.env[name];
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

/** Retain only the backend identity required to locate historical transcripts. */
function historySpawnFingerprint(spawn: AcpSpawnFingerprint): AcpSpawnFingerprint {
  return { preset: spawn.preset, command: '', args: [], ...(spawn.piRuntime ? { piRuntime: spawn.piRuntime } : {}) };
}
