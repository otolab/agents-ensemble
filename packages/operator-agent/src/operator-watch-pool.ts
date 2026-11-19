import { withOperatorWorkspaceLock } from './operator-workspace-lock.js';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT,
  findUserSessionResumeStore,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  listUserLocatedSessionResumeStoresPage,
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  parseIssueUrl,
  resolveUserEnsembleRoot,
  sendOpenQuestionControlRequest,
  userSessionSnapshotPaths,
  type OpenQuestionControlConductorMessage,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionObservationSnapshot,
  type SessionResumeStoreDuplicateDiagnostic,
  type LocatedSessionResumeStore,
  type SessionResumeStore,
} from '@agents-ensemble/core/operator-runtime';
import {
  listOperatorWatchStatePaths,
  operatorWatchStatePath as profileOperatorWatchStatePath,
} from './operator-state-paths.js';
import {
  normalizeRepositoryPattern,
  repositoryMatchesPatterns,
} from './operator-agent-config.js';
import {
  DEFAULT_REPOSITORY_AUTO_POLL_INTERVAL_MS,
  DEFAULT_REPOSITORY_SCAN_INTERVAL_MS,
  MAX_REPOSITORY_AUTO_WATCHES,
  MAX_REPOSITORY_WATCHES,
  MIN_REPOSITORY_SCAN_INTERVAL_MS,
  MAX_REPOSITORY_SCAN_INTERVAL_MS,
  emptyOperatorRepositoryWatchState,
  loadOperatorRepositoryWatchState,
  operatorRepositoryWatchStatePath,
  saveOperatorRepositoryWatchState,
  type OperatorRepositoryWatchState,
  type RepositoryWatchConfig,
} from './operator-repository-watch-state.js';
import type {
  OperatorDispatchEvent,
  OperatorDispatchBatch,
  OperatorDispatchState,
  OperatorDispatchQueue,
} from './operator-dispatch.js';
import { formatOversizedConductorMessageWarning } from './operator-dispatch.js';

const WATCH_STATE_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_DEBOUNCE_MS = 10_000;
const DEFAULT_MESSAGE_DEBOUNCE_MS = 10_000;
const MAX_MESSAGE_DEBOUNCE_MS = 120_000;
const MESSAGE_POLL_INTERVAL_MS = 2_000;
const PENDING_REPORT_REFRESH_INTERVAL_MS = 2_000;
const WATCH_STATE_LOCK_RETRIES = 40;
const WATCH_STATE_LOCK_RETRY_DELAY_MS = 25;

interface WatchConfig {
  conductorAgentId: string;
  pollIntervalMs: number;
  debounceMs: number;
}

interface SessionCursor {
  sequence: number;
  questionFingerprints: Record<string, string>;
  questionSnapshots?: Record<
    string,
    { question: string; status: 'open' | 'answered'; askedAt: number }
  >;
  statusFingerprints: Record<string, string>;
  questionCountObservation?: {
    metric: 'unanswered_open_questions';
    current: {
      count: number;
      checkedAt: number;
      source: 'uds' | 'resume_store';
    };
    previous?: {
      count: number;
      checkedAt: number;
      source: 'uds' | 'resume_store';
    };
  };
}

export interface ConductorMessageListenConfig {
  conductorAgentId: string;
  messageDebounceMs: number;
}

export interface OperatorSessionLiveStatus {
  connectivity: 'reachable' | 'unreachable' | 'unknown';
  checkedAt: number | null;
  unreachableSince: number | null;
  snapshot?: SessionObservationSnapshot;
}

export interface OperatorIdleCandidateObservation {
  conductorAgentId: string;
  issueUrl: string;
  observationVersion: number;
  source: 'uds' | 'resume_store';
  connectivity: OperatorSessionLiveStatus['connectivity'];
  checkedAt: number;
  pollIntervalMs: number;
  harnessPhase?: SessionResumeStore['harnessPhase'];
  harnessModifiedAt?: number;
  lifecycle?: SessionResumeStore['lifecycle'];
  openQuestionCount?: number;
  statusLine?: {
    text: string;
    reportedAt: number;
  };
}

export interface OperatorSessionTrackingInfo {
  firstObservedAt: number | null;
  repositoryWatchEnabled: boolean;
  repositoryScan: {
    status: 'fresh' | 'stale' | 'not_observed';
    checkedAt: number | null;
    error: 'scan_failed' | null;
  };
  watchEnabled: boolean;
  watchSource: 'manual' | 'repository_auto' | 'live_auto' | null;
  watchReason:
    | 'watching'
    | 'auto_watch_capacity'
    | 'suppressed'
    | 'not_registered'
    | 'repository_watch_stopped';
  pollIntervalMs: number | null;
  questionCountObservation?: SessionCursor['questionCountObservation'];
}

interface OperatorWatchState {
  version: typeof WATCH_STATE_VERSION;
  watches: Record<string, WatchConfig>;
  cursors: Record<string, SessionCursor>;
  messageListeners: Record<string, ConductorMessageListenConfig>;
  messageCursors: Record<string, number>;
  idleCandidateFingerprints: Record<
    string,
    Partial<Record<'idle_phase' | 'stale_running', string>>
  >;
  pendingReports: Array<{
    reportId: string;
    reportType:
      | 'session_state'
      | 'open_question'
      | 'conductor_message'
      | 'idle_candidate';
    conductorAgentId: string;
    issueUrl: string;
    text: string;
    debounceMs: number;
    readyAt: number;
    arrivalOrder: number;
    firstQueuedAt: number;
    priority: 'open_question' | 'normal' | 'idle';
    eligibleAt?: number;
    batchReadyAt?: number;
    retryReadyAt?: number;
    frozenBatchId?: string;
    frozenPayload?: string;
    sendCount?: number;
    oversizedSendCounts?: number[];
  }>;
}

export interface OperatorWatchPool {
  register(
    conductorAgentId: string,
    options?: { pollIntervalMs?: number; debounceMs?: number },
  ): Promise<WatchConfig>;
  unregister(conductorAgentId: string): Promise<boolean>;
  list(): WatchConfig[];
  registerRepository(
    githubRepo: string,
    options?: {
      scanIntervalMs?: number;
      pollIntervalMs?: number;
      debounceMs?: number;
    },
  ): Promise<RepositoryWatchConfig>;
  unregisterRepository(githubRepo: string): Promise<boolean>;
  listRepositoryWatches(): RepositoryWatchConfig[];
  scanRepositoriesOnce(): Promise<number>;
  getSessionTrackingInfo(
    conductorAgentId: string,
    issueUrl: string,
  ): OperatorSessionTrackingInfo;
  registerConductorMessageListen(
    conductorAgentId: string,
    options?: { messageDebounceMs?: number },
  ): Promise<ConductorMessageListenConfig>;
  ensureConductorMessageListen(conductorAgentId: string): Promise<{
    listener: ConductorMessageListenConfig;
    created: boolean;
  }>;
  unregisterConductorMessageListen(conductorAgentId: string): Promise<boolean>;
  listConductorMessageListens(): ConductorMessageListenConfig[];
  pollOnce(conductorAgentId: string): Promise<number>;
  pollConductorMessagesOnce(conductorAgentId: string): Promise<number>;
  refreshPendingReports?(): Promise<void>;
  getLiveStatus(conductorAgentId: string): OperatorSessionLiveStatus | undefined;
  listIdleCandidateObservations(): OperatorIdleCandidateObservation[];
  refreshIdleCandidateObservation?(
    conductorAgentId: string,
    afterObservationVersion?: number,
  ): Promise<boolean>;
  acknowledge(events: readonly OperatorDispatchEvent[]): Promise<void>;
  enqueueIdleCandidate?(input: {
    conductorAgentId: string;
    text: string;
    kind: 'idle_phase' | 'stale_running';
    fingerprint: string;
    /** Rechecked after the durable profile lock is acquired. */
    shouldAdmit?: () => boolean;
    /** Requested by the producer; the pool records its actual admission time instead. */
    eligibleAt: number;
  }): Promise<string | undefined>;
  commitBatch(batch: OperatorDispatchBatch, state?: OperatorDispatchState): Promise<boolean>;
  recordRetry?(
    events: readonly OperatorDispatchEvent[],
    retryReadyAt: number,
  ): Promise<void>;
  scanAutoSessionsOnce(): Promise<void>;
  close(): void;
}

export interface CreateOperatorWatchPoolOptions {
  /** User storage root used by the operator-agent runtime. */
  userEnsembleRoot?: string;
  /** Profile whose watch state is active. */
  profile?: string;
  /** Repository patterns allowed by the selected profile and CLI. */
  profileIncludes?: readonly string[];
  repoFilters?: readonly string[];
  /** @deprecated Test and internal compatibility for pre-Phase 3 callers. */
  repoRoot?: string;
  autoDiscoverSessions?: boolean;
  dispatchQueue: OperatorDispatchQueue;
  onError?: (message: string) => void;
}

export function operatorWatchStatePath(
  userEnsembleRoot: string,
  profile: string,
  issueUrl: string,
): string {
  return profileOperatorWatchStatePath(userEnsembleRoot, profile, issueUrl);
}

export async function createOperatorWatchPool(
  options: CreateOperatorWatchPoolOptions,
): Promise<OperatorWatchPool> {
  const root = options.userEnsembleRoot ?? resolveUserEnsembleRoot();
  const profile = options.profile ?? 'default';
  await listOperatorWatchStatePaths(root, profile);
  const stores = (
    await listUserLocatedSessionResumeStoresPage(
      {},
      { userEnsembleRoot: root },
    )
  ).sessions;
  const storesById = new Map<string, LocatedSessionResumeStore[]>();
  for (const located of stores) {
    const matches = storesById.get(located.resumeStore.conductorAgentId) ?? [];
    matches.push(located);
    storesById.set(located.resumeStore.conductorAgentId, matches);
  }
  const issueUrlById = new Map<string, string>();
  const pathById = new Map<string, string>();
  for (const [id, matches] of storesById) {
    if (matches.length !== 1) continue;
    const issueUrl = matches[0]!.resumeStore.issueUrl;
    try {
      const targetPath = profileOperatorWatchStatePath(root, profile, issueUrl);
      issueUrlById.set(id, issueUrl);
      pathById.set(id, targetPath);
    } catch {
      options.onError?.(
        `watch state for ${id} has no valid GitHub Issue URL and cannot be assigned to a profile store.`,
      );
    }
  }

  const loadedStatesByPath = new Map<string, OperatorWatchState>();
  const statePaths = new Set<string>();
  const stateSourcesById = new Map<string, Set<string>>();
  const unassignedStateByPath = new Map<string, OperatorWatchState>();
  const unassignedDiagnostics = new Map<string, string>();
  const ambiguousResumeStoreIds = new Set<string>();
  const reportUnassignedBundle = (
    id: string,
    reason: string,
    sourcePaths: readonly string[],
    bundles: readonly OperatorWatchState[],
  ) => {
    const summary = summarizeWatchStateBundles(id, bundles);
    const signature = hash({
      reason,
      sourcePaths: [...sourcePaths].sort(),
      bundles: bundles.map((bundle) => hash(bundle)),
    });
    if (unassignedDiagnostics.get(id) === signature) return;
    unassignedDiagnostics.set(id, signature);
    options.onError?.(
      `watch state for ${id} remains unresolved (${reason}); retained in ${sourcePaths.length} original profile state file(s): ${summary}.`,
    );
  };
  let state = emptyWatchState();
  const repositoryStatePath = operatorRepositoryWatchStatePath(root, profile);
  let repositoryState = emptyOperatorRepositoryWatchState();
  const fallbackQueuedReportIds = new Set<string>();
  const syncPendingReportsToQueue = () => {
    const reports = state.pendingReports.map((report) => {
      const { readyAt, ...event } = report;
      return {
        event: { type: 'report' as const, ...event },
        readyAt,
      };
    });
    if (options.dispatchQueue.reconcileReports) {
      options.dispatchQueue.reconcileReports(reports);
      return;
    }

    const pendingIds = new Set(reports.map(({ event }) => event.reportId));
    const removed = [...fallbackQueuedReportIds].filter(
      (reportId) => !pendingIds.has(reportId),
    );
    options.dispatchQueue.discardQueuedReports?.(removed);
    for (const reportId of removed) fallbackQueuedReportIds.delete(reportId);
    for (const { event, readyAt } of reports) {
      if (fallbackQueuedReportIds.has(event.reportId)) continue;
      options.dispatchQueue.enqueueReports(
        [event],
        Math.max(0, readyAt - Date.now()),
      );
      fallbackQueuedReportIds.add(event.reportId);
    }
  };
  const refreshStateFromDisk = async (syncQueue = true) => {
    repositoryState = await loadOperatorRepositoryWatchState(
      repositoryStatePath,
    );
    const paths = new Set([
      ...statePaths,
      ...(await listOperatorWatchStatePaths(root, profile)),
    ]);
    loadedStatesByPath.clear();
    statePaths.clear();
    for (const path of paths) {
      loadedStatesByPath.set(path, await loadWatchState(path));
      statePaths.add(path);
    }
    stateSourcesById.clear();
    unassignedStateByPath.clear();
    state = emptyWatchState();
    for (const [path, loaded] of loadedStatesByPath) {
      for (const id of watchStateSessionIds(loaded)) {
        const sourcePaths = stateSourcesById.get(id) ?? new Set<string>();
        sourcePaths.add(path);
        stateSourcesById.set(id, sourcePaths);
      }
    }
    for (const id of stateSourcesById.keys()) {
      const sourcePaths = [...(stateSourcesById.get(id) ?? [])];
      const sourceBundles = sourcePaths.map((path) =>
        extractWatchStateForSession(loadedStatesByPath.get(path)!, id),
      );
      const targetPath = pathById.get(id);
      const expectedIssueUrl = issueUrlById.get(id);
      let reason: string | undefined;
      if (!targetPath || !expectedIssueUrl) {
        reason =
          ambiguousResumeStoreIds.has(id) ||
          (storesById.get(id)?.length ?? 0) > 1
            ? 'multiple SessionResumeStores exist for this conductor ID'
            : 'no unique verified Issue session is available';
      } else if (sourcePaths.length !== 1) {
        reason = 'the session appears in multiple profile state files';
      } else if (sourcePaths[0] !== targetPath) {
        reason = 'the source repository scope does not match the saved Issue URL';
      } else if (
        sourceBundles.some((bundle) =>
          bundle.pendingReports.some(
            (report) =>
              issueIdentity(report.issueUrl) !== issueIdentity(expectedIssueUrl),
          ),
        )
      ) {
        reason = 'a pending report Issue URL does not match the saved Issue session';
      }

      if (reason) {
        for (const [index, sourcePath] of sourcePaths.entries()) {
          const retained =
            unassignedStateByPath.get(sourcePath) ?? emptyWatchState();
          unassignedStateByPath.set(
            sourcePath,
            mergeWatchStates(sourceBundles[index]!, retained),
          );
        }
        reportUnassignedBundle(id, reason, sourcePaths, sourceBundles);
        continue;
      }
      state = mergeWatchStates(state, sourceBundles[0]!);
      unassignedDiagnostics.delete(id);
    }
    if (syncQueue) syncPendingReportsToQueue();
  };
  await withWatchStateLock(root, profile, () => refreshStateFromDisk());
  const timers = new Map<string, NodeJS.Timeout>();
  const autoWatches = new Map<string, WatchConfig>();
  let autoScanTimer: NodeJS.Timeout | undefined;
  let autoScanInFlight = false;
  const repositoryTimers = new Map<string, NodeJS.Timeout>();
  const repositoryScansInFlight = new Set<string>();
  const polling = new Set<string>();
  const pollCompletions = new Map<string, Promise<void>>();
  const messageTimers = new Map<string, NodeJS.Timeout>();
  const messagePolling = new Set<string>();
  const liveStatuses = new Map<string, OperatorSessionLiveStatus>();
  const idleCandidateObservations = new Map<
    string,
    OperatorIdleCandidateObservation
  >();
  let idleCandidateObservationVersion = 0;
  const reportedResumeStoreDuplicates = new Map<string, string>();
  const onResumeStoreDuplicate = (
    diagnostic: SessionResumeStoreDuplicateDiagnostic,
  ) => {
    ambiguousResumeStoreIds.add(diagnostic.conductorAgentId);
    const signature = JSON.stringify(diagnostic);
    if (
      reportedResumeStoreDuplicates.get(diagnostic.conductorAgentId) ===
      signature
    ) {
      return;
    }
    reportedResumeStoreDuplicates.set(diagnostic.conductorAgentId, signature);
    if (
      watchStateSessionIds(
        extractWatchStateForSession(state, diagnostic.conductorAgentId),
      ).size === 0
    ) {
      options.onError?.(formatResumeStoreDuplicateDiagnostic(diagnostic));
    }
  };
  let closed = false;
  let stateOperationQueue = Promise.resolve();
  let pendingReportRefreshTimer: NodeJS.Timeout | undefined;
  let pendingReportRefreshInFlight = false;

  const persist = async () => {
    const partitions = partitionWatchState(state, pathById, issueUrlById);
    for (const [path, retained] of unassignedStateByPath) {
      partitions.set(
        path,
        mergeWatchStates(partitions.get(path) ?? emptyWatchState(), retained),
      );
    }
    for (const [path, partition] of partitions) {
      statePaths.add(path);
      await saveWatchState(path, partition);
    }
    for (const path of statePaths) {
      if (!partitions.has(path)) {
        await saveWatchState(path, emptyWatchState());
      }
    }
  };
  const persistRepositoryState = async () => {
    await saveOperatorRepositoryWatchState(
      repositoryStatePath,
      repositoryState,
    );
  };
  const retainReadyBatch = (conductorAgentId: string, now: number) => {
    const reports = state.pendingReports
      .filter((report) =>
        report.conductorAgentId === conductorAgentId && !report.frozenBatchId)
      .sort((left, right) => left.arrivalOrder - right.arrivalOrder);
    if (reports.length === 0) return;
    const readyAt = Math.min(
      ...reports.map((report) => report.batchReadyAt ?? Infinity),
      Math.max(...reports.map((report) => report.readyAt)),
      Math.min(...reports.map((report) =>
        report.firstQueuedAt + options.dispatchQueue.batchMaxWaitMs)),
    );
    if (readyAt <= now) reports[0]!.batchReadyAt = readyAt;
  };
  const deferWatchPendingReports = (
    conductorAgentId: string,
    debounceMs: number,
  ) => {
    const now = Date.now();
    retainReadyBatch(conductorAgentId, now);
    const readyAt = now + Math.max(0, debounceMs);
    for (const report of state.pendingReports) {
      if (
        report.conductorAgentId === conductorAgentId &&
        report.reportType !== 'conductor_message' &&
        !report.frozenBatchId
      ) {
        report.readyAt = readyAt;
      }
    }
  };
  const withStateLock = <T>(
    operation: (nextArrivalOrder: () => number) => Promise<T>,
    syncQueue = true,
  ): Promise<T> => {
    const next = stateOperationQueue.then(() =>
      withWatchStateLock(root, profile, async (nextArrivalOrder) => {
        await refreshStateFromDisk(syncQueue);
        const allocateArrivalOrder = () =>
          nextArrivalOrder(
            Math.max(
              0,
              ...state.pendingReports.map(
                (report) => report.arrivalOrder ?? 0,
              ),
            ),
          );
        const result = await operation(allocateArrivalOrder);
        if (syncQueue) syncPendingReportsToQueue();
        return result;
      }),
    );
    stateOperationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const refreshPendingReports = async () => {
    if (closed) return;
    await withStateLock(async () => undefined);
  };
  const startTimer = (watch: WatchConfig) => {
    if (timers.has(watch.conductorAgentId)) return;
    const timer = setInterval(() => {
      void pool.pollOnce(watch.conductorAgentId).catch((error: unknown) => {
        options.onError?.(formatWatchPollError(watch.conductorAgentId, error));
      });
    }, watch.pollIntervalMs);
    timer.unref();
    timers.set(watch.conductorAgentId, timer);
  };
  const startRepositoryTimer = (watch: RepositoryWatchConfig) => {
    if (repositoryTimers.has(watch.githubRepo)) return;
    const timer = setInterval(() => {
      void scanRepositoryOnce(watch.githubRepo).catch((error: unknown) => {
        options.onError?.(
          `repository watch scan failed for ${watch.githubRepo}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, watch.scanIntervalMs);
    timer.unref();
    repositoryTimers.set(watch.githubRepo, timer);
  };
  const startMessageTimer = (listener: ConductorMessageListenConfig) => {
    if (messageTimers.has(listener.conductorAgentId)) return;
    const timer = setInterval(() => {
      void pool
        .pollConductorMessagesOnce(listener.conductorAgentId)
        .catch((error: unknown) => {
          options.onError?.(
            formatConductorMessagePollError(listener.conductorAgentId, error),
          );
        });
    }, MESSAGE_POLL_INTERVAL_MS);
    timer.unref();
    messageTimers.set(listener.conductorAgentId, timer);
  };
  const quarantineActiveSession = (
    id: string,
    reason: string,
  ): boolean => {
    const activeBundle = extractWatchStateForSession(state, id);
    if (watchStateSessionIds(activeBundle).size === 0) return false;
    const sourcePath = pathById.get(id);
    if (!sourcePath) return false;

    removeWatchStateForSession(state, id);
    const retained = unassignedStateByPath.get(sourcePath) ?? emptyWatchState();
    unassignedStateByPath.set(
      sourcePath,
      mergeWatchStates(retained, activeBundle),
    );
    options.dispatchQueue.discardQueuedReports?.(
      activeBundle.pendingReports.map((report) => report.reportId),
    );
    idleCandidateObservations.delete(id);
    const watchTimer = timers.get(id);
    if (watchTimer) clearInterval(watchTimer);
    timers.delete(id);
    const messageTimer = messageTimers.get(id);
    if (messageTimer) clearInterval(messageTimer);
    messageTimers.delete(id);
    pathById.delete(id);
    issueUrlById.delete(id);
    reportUnassignedBundle(id, reason, [sourcePath], [activeBundle]);
    return true;
  };
  const locateSession = async (
    id: string,
  ): Promise<LocatedSessionResumeStore | undefined> => {
    try {
      const located = await findSession(id, {
        root,
        onDuplicate: onResumeStoreDuplicate,
      });
      if (located) ambiguousResumeStoreIds.delete(id);
      if (!located) {
        quarantineActiveSession(
          id,
          'no unique verified Issue session is available',
        );
      }
      return located;
    } catch (error) {
      if (isAmbiguousResumeStoreError(error)) {
        ambiguousResumeStoreIds.add(id);
        quarantineActiveSession(
          id,
          'multiple SessionResumeStores exist for this conductor ID',
        );
      }
      throw error;
    }
  };
  const bindLocatedSession = (
    id: string,
    located: LocatedSessionResumeStore,
  ): { assigned: boolean; reason?: string } => {
    let targetPath: string;
    try {
      targetPath = profileOperatorWatchStatePath(
        root,
        profile,
        located.resumeStore.issueUrl,
      );
    } catch {
      const sources = [...(stateSourcesById.get(id) ?? [])];
      const bundles = sources.map((path) =>
        unassignedStateByPath.has(path)
          ? extractWatchStateForSession(unassignedStateByPath.get(path)!, id)
          : extractWatchStateForSession(state, id),
      );
      const reason = 'the saved Issue URL is invalid';
      if (!quarantineActiveSession(id, reason)) {
        reportUnassignedBundle(id, reason, sources, bundles);
      }
      return { assigned: false, reason };
    }
    const nextIssueUrl = located.resumeStore.issueUrl;
    const sourcePaths = [...(stateSourcesById.get(id) ?? [])];
    const retainedPaths = [...unassignedStateByPath.entries()]
      .filter(([, bundle]) => watchStateSessionIds(bundle).has(id))
      .map(([path]) => path);
    const allSourcePaths = [...new Set([...sourcePaths, ...retainedPaths])];
    const bundles = allSourcePaths.map((path) => {
      const retained = unassignedStateByPath.get(path);
      return retained
        ? extractWatchStateForSession(retained, id)
        : extractWatchStateForSession(
            loadedStatesByPath.get(path) ?? emptyWatchState(),
            id,
          );
    });
    if (retainedPaths.length > 0) {
      let reason: string | undefined;
      if (retainedPaths.length !== 1 || allSourcePaths.length !== 1) {
        reason = 'the session appears in multiple profile state files';
      } else if (retainedPaths[0] !== targetPath) {
        reason = 'the source repository scope does not match the saved Issue URL';
      } else if (
        bundles.some((bundle) =>
          bundle.pendingReports.some(
            (report) =>
              issueIdentity(report.issueUrl) !== issueIdentity(nextIssueUrl),
          ),
        )
      ) {
        reason = 'a pending report Issue URL does not match the saved Issue session';
      }
      if (reason) {
        reportUnassignedBundle(id, reason, allSourcePaths, bundles);
        return { assigned: false, reason };
      }
      const retainedPath = retainedPaths[0]!;
      const retained = unassignedStateByPath.get(retainedPath)!;
      const promoted = extractWatchStateForSession(retained, id);
      removeWatchStateForSession(retained, id);
      if (watchStateSessionIds(retained).size === 0) {
        unassignedStateByPath.delete(retainedPath);
      }
      state = mergeWatchStates(state, promoted);
    }

    const previousPath = pathById.get(id);
    const previousIssueUrl = issueUrlById.get(id);
    if (
      previousPath &&
      (previousPath !== targetPath ||
        (previousIssueUrl !== undefined &&
          issueIdentity(previousIssueUrl) !== issueIdentity(nextIssueUrl)))
    ) {
      const reason = 'the verified Issue identity changed for this session ID';
      quarantineActiveSession(id, reason);
      return { assigned: false, reason };
    }
    pathById.set(id, targetPath);
    issueUrlById.set(id, nextIssueUrl);
    statePaths.add(targetPath);
    reportedResumeStoreDuplicates.delete(id);
    unassignedDiagnostics.delete(id);
    return { assigned: true };
  };
  const verifyUniqueLocatedSession = async (
    id: string,
    located: LocatedSessionResumeStore,
  ): Promise<boolean> => {
    const initialMatches = storesById.get(id);
    if (initialMatches && initialMatches.length > 1) return false;
    if (initialMatches?.length === 1) {
      return (
        issueIdentity(initialMatches[0]!.resumeStore.issueUrl) ===
        issueIdentity(located.resumeStore.issueUrl)
      );
    }
    try {
      const verified = await locateSession(id);
      return (
        verified !== undefined &&
        issueIdentity(verified.resumeStore.issueUrl) ===
          issueIdentity(located.resumeStore.issueUrl)
      );
    } catch (error) {
      if (isAmbiguousResumeStoreError(error)) return false;
      throw error;
    }
  };
  const assertRepositoryAllowed = (value: string): string => {
    const repository = normalizeRepositoryPattern(value);
    if (repository.endsWith('/*')) {
      throw new Error('githubRepo must name one exact owner/repo.');
    }
    const includes = options.profileIncludes?.length
      ? options.profileIncludes.map((pattern) =>
          normalizeRepositoryPattern(pattern),
        )
      : undefined;
    if (
      includes &&
      !repositoryMatchesPatterns(repository, includes)
    ) {
      throw new Error(
        `Repository ${repository} is outside the selected profile include scope.`,
      );
    }
    const filters = options.repoFilters?.length
      ? options.repoFilters.map((pattern) =>
          normalizeRepositoryPattern(pattern),
        )
      : undefined;
    if (filters && !repositoryMatchesPatterns(repository, filters)) {
      throw new Error(
        `Repository ${repository} is outside the active --repo-filter scope.`,
      );
    }
    return repository;
  };
  const repositoryIsInActiveScope = (repository: string): boolean => {
    try {
      assertRepositoryAllowed(repository);
      return true;
    } catch {
      return false;
    }
  };
  const nextFirstObservedAt = (): number => {
    let latest = -1;
    for (const discoveries of Object.values(repositoryState.discoveries)) {
      for (const discovery of Object.values(discoveries)) {
        latest = Math.max(latest, discovery.firstObservedAt);
      }
    }
    return Math.max(Date.now(), latest + 1);
  };
  const listRepositoryStores = async (
    githubRepo: string,
  ): Promise<LocatedSessionResumeStore[]> => {
    const sessions: LocatedSessionResumeStore[] = [];
    let cursor: string | undefined;
    do {
      const page = await listUserLocatedSessionResumeStoresPage(
        {
          githubRepo,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        },
        {
          userEnsembleRoot: root,
          onDuplicate: onResumeStoreDuplicate,
        },
      );
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  };
  const reconcileRepositoryAutoWatches = () => {
    const previousManaged = new Set<string>();
    const candidates: Array<{
      id: string;
      githubRepo: string;
      firstObservedAt: number;
      config: RepositoryWatchConfig;
    }> = [];
    for (const config of Object.values(repositoryState.watches)) {
      for (const id of config.managedSessionIds) previousManaged.add(id);
      if (!repositoryIsInActiveScope(config.githubRepo)) continue;
      const discoveries = repositoryState.discoveries[config.githubRepo] ?? {};
      const manual = new Set(config.manualSessionIds);
      const suppressed = new Set(config.suppressedSessionIds);
      for (const id of config.managedSessionIds) {
        const discovery = discoveries[id];
        if (!discovery || manual.has(id) || suppressed.has(id)) continue;
        candidates.push({
          id,
          githubRepo: config.githubRepo,
          firstObservedAt: discovery.firstObservedAt,
          config,
        });
      }
    }
    candidates.sort(
      (left, right) =>
        right.firstObservedAt - left.firstObservedAt ||
        left.githubRepo.localeCompare(right.githubRepo) ||
        left.id.localeCompare(right.id),
    );
    const selected = new Map(
      candidates
        .slice(0, MAX_REPOSITORY_AUTO_WATCHES)
        .map((candidate) => [candidate.id, candidate]),
    );
    for (const id of previousManaged) {
      const stillManual = Object.values(repositoryState.watches).some(
        (config) => config.manualSessionIds.includes(id),
      );
      if (!selected.has(id) && !stillManual) delete state.watches[id];
    }
    for (const candidate of selected.values()) {
      if (candidate.config.manualSessionIds.includes(candidate.id)) continue;
      state.watches[candidate.id] = {
        conductorAgentId: candidate.id,
        pollIntervalMs: candidate.config.pollIntervalMs,
        debounceMs: candidate.config.debounceMs,
      };
    }
  };
  const syncSessionWatchTimers = () => {
    const active = new Map(
      pool.list().map((watch) => [watch.conductorAgentId, watch]),
    );
    for (const [id, watch] of autoWatches) {
      if (!active.has(id)) active.set(id, watch);
    }
    for (const [id, timer] of timers) {
      if (!active.has(id)) {
        clearInterval(timer);
        timers.delete(id);
      }
    }
    for (const watch of active.values()) {
      const existing = timers.get(watch.conductorAgentId);
      if (existing) clearInterval(existing);
      timers.delete(watch.conductorAgentId);
      startTimer(watch);
    }
  };
  const syncRepositoryWatchTimers = () => {
    const active = new Map(
      Object.values(repositoryState.watches)
        .filter((watch) => repositoryIsInActiveScope(watch.githubRepo))
        .map((watch) => [watch.githubRepo, watch]),
    );
    for (const [githubRepo, timer] of repositoryTimers) {
      if (!active.has(githubRepo)) {
        clearInterval(timer);
        repositoryTimers.delete(githubRepo);
      }
    }
    for (const watch of active.values()) {
      const existing = repositoryTimers.get(watch.githubRepo);
      if (existing) clearInterval(existing);
      repositoryTimers.delete(watch.githubRepo);
      startRepositoryTimer(watch);
    }
  };
  const scanRepositoryOnce = async (githubRepo: string): Promise<number> => {
    if (closed || repositoryScansInFlight.has(githubRepo)) return 0;
    repositoryScansInFlight.add(githubRepo);
    try {
      const locatedSessions = await listRepositoryStores(githubRepo);
      const grouped = new Map<string, LocatedSessionResumeStore[]>();
      for (const located of locatedSessions) {
        const id = located.resumeStore.conductorAgentId;
        const matches = grouped.get(id) ?? [];
        matches.push(located);
        grouped.set(id, matches);
      }
      let added = 0;
      await withStateLock(async () => {
        const config = repositoryState.watches[githubRepo];
        if (!config || closed) return;
        const discoveries =
          (repositoryState.discoveries[githubRepo] ??= {});
        const now = Date.now();
        const firstObservedAt = nextFirstObservedAt();
        config.lastScanAttemptAt = now;
        config.lastSuccessfulScanAt = now;
        config.lastScanError = null;
        for (const [id, matches] of [...grouped].sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          if (
            matches.length !== 1 ||
            ambiguousResumeStoreIds.has(id) ||
            !(await verifyUniqueLocatedSession(id, matches[0]!))
          ) {
            ambiguousResumeStoreIds.add(id);
            options.onError?.(
              `repository watch skipped ambiguous conductor ID ${id} in ${githubRepo}.`,
            );
            continue;
          }
          const located = matches[0]!;
          if (!discoveries[id]) {
            discoveries[id] = {
              issueUrl: located.resumeStore.issueUrl,
              firstObservedAt,
            };
            added += 1;
          }
          if (
            config.suppressedSessionIds.includes(id) ||
            config.manualSessionIds.includes(id)
          ) {
            continue;
          }
          const binding = bindLocatedSession(id, located);
          if (!binding.assigned) {
            options.onError?.(
              `repository watch could not bind ${id}: ${binding.reason ?? 'unknown reason'}.`,
            );
            continue;
          }
          if (!config.managedSessionIds.includes(id)) {
            config.managedSessionIds.push(id);
          }
        }
        // A deleted resume store is no longer a live candidate. Keep its first
        // observation record, but stop polling it while its repository is watched.
        const present = new Set(grouped.keys());
        config.managedSessionIds = config.managedSessionIds.filter((id) => {
          if (present.has(id)) return true;
          delete state.watches[id];
          return false;
        });
        reconcileRepositoryAutoWatches();
        await persist();
        await persistRepositoryState();
      });
      syncSessionWatchTimers();
      return added;
    } catch (error) {
      await withStateLock(async () => {
        const config = repositoryState.watches[githubRepo];
        if (!config) return;
        config.lastScanAttemptAt = Date.now();
        config.lastScanError = 'scan_failed';
        await persistRepositoryState();
      });
      throw error;
    } finally {
      repositoryScansInFlight.delete(githubRepo);
    }
  };
  const pool: OperatorWatchPool = {
    async register(conductorAgentId, input = {}) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const watch = await withStateLock(async () => {
        const located = await locateSession(id);
        if (!located) throw new Error(`No saved session found for ${id}.`);
        const binding = bindLocatedSession(id, located);
        if (!binding.assigned) {
          throw new Error(
            `Watch state for ${id} remains unresolved and was retained: ${binding.reason}.`,
          );
        }
        const nextWatch = {
          conductorAgentId: id,
          pollIntervalMs: parseBoundedInteger(
            input.pollIntervalMs,
            DEFAULT_POLL_INTERVAL_MS,
            MIN_POLL_INTERVAL_MS,
            MAX_POLL_INTERVAL_MS,
            'pollIntervalMs',
          ),
          debounceMs: parseBoundedInteger(
            input.debounceMs,
            250,
            0,
            MAX_DEBOUNCE_MS,
            'debounceMs',
          ),
        };
        const previousWatch = state.watches[id];
        const repository =
          repositoryForIssue(located.resumeStore.issueUrl);
        const repositoryConfig = repository
          ? repositoryState.watches[repository]
          : undefined;
        const previousRepositoryConfig = repositoryConfig
          ? { ...repositoryConfig,
              managedSessionIds: [...repositoryConfig.managedSessionIds],
              manualSessionIds: [...repositoryConfig.manualSessionIds],
              suppressedSessionIds: [...repositoryConfig.suppressedSessionIds],
            }
          : undefined;
        state.watches[id] = nextWatch;
        if (repositoryConfig) {
          repositoryConfig.managedSessionIds =
            repositoryConfig.managedSessionIds.filter((item) => item !== id);
          repositoryConfig.suppressedSessionIds =
            repositoryConfig.suppressedSessionIds.filter((item) => item !== id);
          if (!repositoryConfig.manualSessionIds.includes(id)) {
            repositoryConfig.manualSessionIds.push(id);
          }
        }
        try {
          await persist();
          if (repositoryConfig) await persistRepositoryState();
        } catch (error) {
          if (previousWatch) state.watches[id] = previousWatch;
          else delete state.watches[id];
          if (repositoryConfig && previousRepositoryConfig) {
            repositoryState.watches[repository!] = previousRepositoryConfig;
          }
          throw error;
        }
        return nextWatch;
      });
      const existingTimer = timers.get(id);
      if (existingTimer) clearInterval(existingTimer);
      timers.delete(id);
      startTimer(watch);
      const existingListener = state.messageListeners[id];
      if (existingListener) startMessageTimer(existingListener);
      return watch;
    },
    async unregister(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const removed = await withStateLock(async () => {
        const previousWatch = state.watches[id];
        if (!previousWatch) return false;
        delete state.watches[id];
        const repositoryConfig = Object.values(repositoryState.watches).find(
          (config) =>
            config.manualSessionIds.includes(id) ||
            config.managedSessionIds.includes(id),
        );
        const previousRepositoryConfig = repositoryConfig
          ? { ...repositoryConfig,
              managedSessionIds: [...repositoryConfig.managedSessionIds],
              manualSessionIds: [...repositoryConfig.manualSessionIds],
              suppressedSessionIds: [...repositoryConfig.suppressedSessionIds],
            }
          : undefined;
        if (repositoryConfig) {
          repositoryConfig.manualSessionIds =
            repositoryConfig.manualSessionIds.filter((item) => item !== id);
          repositoryConfig.managedSessionIds =
            repositoryConfig.managedSessionIds.filter((item) => item !== id);
          if (!repositoryConfig.suppressedSessionIds.includes(id)) {
            repositoryConfig.suppressedSessionIds.push(id);
          }
        }
        try {
          await persist();
          if (repositoryConfig) await persistRepositoryState();
        } catch (error) {
          state.watches[id] = previousWatch;
          if (repositoryConfig && previousRepositoryConfig) {
            repositoryState.watches[repositoryConfig.githubRepo] =
              previousRepositoryConfig;
          }
          throw error;
        }
        return true;
      });
      if (!removed) return false;
      idleCandidateObservations.delete(id);
      const timer = timers.get(id);
      if (timer) clearInterval(timer);
      timers.delete(id);
      return true;
    },
    list() {
      return Object.values(state.watches).map((watch) => ({ ...watch }));
    },
    async registerRepository(githubRepo, input = {}) {
      const repository = assertRepositoryAllowed(githubRepo);
      const scanIntervalMs = parseBoundedInteger(
        input.scanIntervalMs,
        DEFAULT_REPOSITORY_SCAN_INTERVAL_MS,
        MIN_REPOSITORY_SCAN_INTERVAL_MS,
        MAX_REPOSITORY_SCAN_INTERVAL_MS,
        'scanIntervalMs',
      );
      const pollIntervalMs = parseBoundedInteger(
        input.pollIntervalMs,
        DEFAULT_REPOSITORY_AUTO_POLL_INTERVAL_MS,
        MIN_POLL_INTERVAL_MS,
        MAX_POLL_INTERVAL_MS,
        'pollIntervalMs',
      );
      const debounceMs = parseBoundedInteger(
        input.debounceMs,
        250,
        0,
        MAX_DEBOUNCE_MS,
        'debounceMs',
      );
      const alreadyRegistered = await withStateLock(async () => {
        const current = repositoryState.watches[repository];
        if (!current) return false;
        const previous = { ...current };
        repositoryState.watches[repository] = {
          ...current,
          scanIntervalMs,
          pollIntervalMs,
          debounceMs,
        };
        try {
          reconcileRepositoryAutoWatches();
          await persist();
          await persistRepositoryState();
        } catch (error) {
          repositoryState.watches[repository] = previous;
          throw error;
        }
        return true;
      });
      if (alreadyRegistered) {
        syncSessionWatchTimers();
        syncRepositoryWatchTimers();
        return structuredClone(repositoryState.watches[repository]!);
      }

      // Capture the baseline outside the profile lock: each page may read
      // hundreds of saved runs, while all state mutation remains serialized.
      const baseline = await listRepositoryStores(repository);
      const config = await withStateLock(async () => {
        const existing = repositoryState.watches[repository];
        if (existing) return structuredClone(existing);
        if (Object.keys(repositoryState.watches).length >= MAX_REPOSITORY_WATCHES) {
          throw new Error(
            `At most ${MAX_REPOSITORY_WATCHES} repositories can be watched in one profile.`,
          );
        }
        const next: RepositoryWatchConfig = {
          githubRepo: repository,
          enabledAt: Date.now(),
          lastScanAttemptAt: Date.now(),
          lastSuccessfulScanAt: Date.now(),
          lastScanError: null,
          scanIntervalMs,
          pollIntervalMs,
          debounceMs,
          managedSessionIds: [],
          manualSessionIds: [],
          suppressedSessionIds: [],
        };
        const discoveries =
          (repositoryState.discoveries[repository] ??= {});
        const grouped = new Map<string, LocatedSessionResumeStore[]>();
        for (const located of baseline) {
          const id = located.resumeStore.conductorAgentId;
          const matches = grouped.get(id) ?? [];
          matches.push(located);
          grouped.set(id, matches);
        }
        const baselineFirstObservedAt = nextFirstObservedAt();
        for (const [id, matches] of [...grouped].sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          if (
            matches.length !== 1 ||
            ambiguousResumeStoreIds.has(id) ||
            !(await verifyUniqueLocatedSession(id, matches[0]!))
          ) {
            ambiguousResumeStoreIds.add(id);
            options.onError?.(
              `repository watch skipped ambiguous conductor ID ${id} in ${repository}.`,
            );
            continue;
          }
          const located = matches[0]!;
          discoveries[id] ??= {
            issueUrl: located.resumeStore.issueUrl,
            firstObservedAt: baselineFirstObservedAt,
          };
          const binding = bindLocatedSession(id, located);
          if (!binding.assigned) {
            options.onError?.(
              `repository watch could not bind ${id}: ${binding.reason ?? 'unknown reason'}.`,
            );
            continue;
          }
          if (state.watches[id]) {
            next.manualSessionIds.push(id);
          } else {
            next.managedSessionIds.push(id);
          }
        }
        repositoryState.watches[repository] = next;
        reconcileRepositoryAutoWatches();
        try {
          await persist();
          await persistRepositoryState();
        } catch (error) {
          delete repositoryState.watches[repository];
          throw error;
        }
        return structuredClone(next);
      });
      syncSessionWatchTimers();
      syncRepositoryWatchTimers();
      return config;
    },
    async unregisterRepository(githubRepo) {
      const repository = assertRepositoryAllowed(githubRepo);
      const removed = await withStateLock(async () => {
        const config = repositoryState.watches[repository];
        if (!config) return false;
        delete repositoryState.watches[repository];
        for (const id of config.managedSessionIds) {
          delete state.watches[id];
        }
        try {
          await persist();
          await persistRepositoryState();
        } catch (error) {
          repositoryState.watches[repository] = config;
          reconcileRepositoryAutoWatches();
          throw error;
        }
        return true;
      });
      if (!removed) return false;
      syncSessionWatchTimers();
      syncRepositoryWatchTimers();
      return true;
    },
    listRepositoryWatches() {
      return Object.values(repositoryState.watches)
        .filter((watch) => repositoryIsInActiveScope(watch.githubRepo))
        .map((watch) =>
        structuredClone(watch),
        );
    },
    async scanRepositoriesOnce() {
      const repositories = Object.keys(repositoryState.watches).filter(
        repositoryIsInActiveScope,
      );
      let discovered = 0;
      for (const repository of repositories) {
        discovered += await scanRepositoryOnce(repository);
      }
      return discovered;
    },
    getSessionTrackingInfo(conductorAgentId, issueUrl) {
      let repository: string | undefined;
      try {
        repository = repositoryForIssue(issueUrl);
      } catch {
        repository = undefined;
      }
      const discovery = repository
        ? repositoryState.discoveries[repository]?.[conductorAgentId]
        : undefined;
      const repositoryConfig = repository
        ? repositoryState.watches[repository]
        : undefined;
      const configuredWatch = state.watches[conductorAgentId];
      const activeWatch = configuredWatch ?? (
        issueIdentity(issueUrl) !== undefined &&
        issueIdentity(issueUrlById.get(conductorAgentId) ?? '') === issueIdentity(issueUrl)
          ? autoWatches.get(conductorAgentId)
          : undefined
      );
      const isManual =
        repositoryConfig?.manualSessionIds.includes(conductorAgentId) ??
        false;
      const isManaged =
        repositoryConfig?.managedSessionIds.includes(conductorAgentId) ??
        false;
      let watchReason: OperatorSessionTrackingInfo['watchReason'];
      if (activeWatch) {
        watchReason =
          isManual || !isManaged ? 'watching' : 'watching';
      } else if (!repositoryConfig && discovery) {
        watchReason = 'repository_watch_stopped';
      } else if (
        repositoryConfig?.suppressedSessionIds.includes(conductorAgentId)
      ) {
        watchReason = 'suppressed';
      } else if (isManaged) {
        watchReason = 'auto_watch_capacity';
      } else {
        watchReason = 'not_registered';
      }
      const watchSource: OperatorSessionTrackingInfo['watchSource'] =
        !activeWatch
          ? null
          : !configuredWatch
            ? 'live_auto'
            : isManual || !isManaged
            ? 'manual'
            : 'repository_auto';
      return {
        firstObservedAt:
          discovery && issueIdentity(discovery.issueUrl) === issueIdentity(issueUrl)
            ? discovery.firstObservedAt
            : null,
        repositoryWatchEnabled: repositoryConfig !== undefined,
        repositoryScan: {
          status:
            repositoryConfig?.lastSuccessfulScanAt === null ||
            repositoryConfig?.lastSuccessfulScanAt === undefined
              ? 'not_observed'
              : repositoryConfig.lastScanError ||
                  Date.now() - repositoryConfig.lastSuccessfulScanAt >
                    repositoryConfig.scanIntervalMs * 2
                ? 'stale'
                : 'fresh',
          checkedAt: repositoryConfig?.lastSuccessfulScanAt ?? null,
          error: repositoryConfig?.lastScanError ?? null,
        },
        watchEnabled: activeWatch !== undefined,
        watchSource,
        watchReason,
        pollIntervalMs: activeWatch?.pollIntervalMs ?? null,
        ...(state.cursors[conductorAgentId]?.questionCountObservation
          ? {
              questionCountObservation: structuredClone(
                state.cursors[conductorAgentId]!.questionCountObservation,
              ),
            }
          : {}),
      };
    },
    async ensureConductorMessageListen(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      let created = false;
      const listener = await withStateLock(async () => {
        const located = await locateSession(id);
        if (!located) throw new Error(`No saved session found for ${id}.`);
        const binding = bindLocatedSession(id, located);
        if (!binding.assigned) throw new Error(`Watch state for ${id} remains unresolved: ${binding.reason}.`);
        const existing = state.messageListeners[id];
        const selected = existing ?? { conductorAgentId: id, messageDebounceMs: DEFAULT_MESSAGE_DEBOUNCE_MS };
        if (state.messageCursors[id] === undefined) {
          const socketPath = located.resumeStore.harnessSocketPath;
          if (!socketPath) throw new Error(`No live harness socket for ${id}.`);
          const baseline = await readConductorMessageBaseline(socketPath);
          state.messageCursors[id] = baseline;
        }
        if (!existing) {
          created = true;
          state.messageListeners[id] = selected;
          deferWatchPendingReports(id, Math.max(selected.messageDebounceMs, state.watches[id]?.debounceMs ?? 0));
        }
        await persist();
        return selected;
      });
      if (created) {
        options.dispatchQueue.deferWatchReports?.(
          id, Math.max(listener.messageDebounceMs, state.watches[id]?.debounceMs ?? 0),
        );
      }
      if (!messageTimers.has(id)) startMessageTimer(listener);
      return { listener, created };
    },
    async registerConductorMessageListen(conductorAgentId, input = {}) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const listener = {
        conductorAgentId: id,
        messageDebounceMs: parseBoundedInteger(
          input.messageDebounceMs,
          DEFAULT_MESSAGE_DEBOUNCE_MS,
          0,
          MAX_MESSAGE_DEBOUNCE_MS,
          'messageDebounceMs',
        ),
      };
      let previous: ConductorMessageListenConfig | undefined;
      let previousCursor: number | undefined;
      await withStateLock(async () => {
        const located = await locateSession(id);
        if (!located) throw new Error(`No saved session found for ${id}.`);
        const binding = bindLocatedSession(id, located);
        if (!binding.assigned) {
          throw new Error(
            `Watch state for ${id} remains unresolved and was retained: ${binding.reason}.`,
          );
        }
        previous = state.messageListeners[id];
        previousCursor = state.messageCursors[id];
        state.messageListeners[id] = listener;
        deferWatchPendingReports(
          id,
          Math.max(
            listener.messageDebounceMs,
            state.watches[id]?.debounceMs ?? 0,
          ),
        );
        try {
          await persist();
        } catch (error) {
          if (previous) state.messageListeners[id] = previous;
          else delete state.messageListeners[id];
          deferWatchPendingReports(
            id,
            Math.max(
              previous?.messageDebounceMs ?? 0,
              state.watches[id]?.debounceMs ?? 0,
            ),
          );
          throw error;
        }
      });
      options.dispatchQueue.deferWatchReports?.(
        id,
        Math.max(
          listener.messageDebounceMs,
          state.watches[id]?.debounceMs ?? 0,
        ),
      );
      const existingTimer = messageTimers.get(id);
      if (existingTimer) clearInterval(existingTimer);
      messageTimers.delete(id);
      startMessageTimer(listener);
      try {
        await pool.pollConductorMessagesOnce(id);
      } catch (error) {
        const timer = messageTimers.get(id);
        if (timer) clearInterval(timer);
        messageTimers.delete(id);
        try {
          await withStateLock(async () => {
            if (
              state.messageListeners[id]?.messageDebounceMs !==
              listener.messageDebounceMs
            ) {
              return;
            }
            if (previous) state.messageListeners[id] = previous;
            else delete state.messageListeners[id];
            if (previousCursor === undefined) {
              delete state.messageCursors[id];
            } else {
              state.messageCursors[id] = previousCursor;
            }
            deferWatchPendingReports(
              id,
              Math.max(
                previous?.messageDebounceMs ?? 0,
                state.watches[id]?.debounceMs ?? 0,
              ),
            );
            await persist();
          });
        } catch (rollbackError) {
          options.dispatchQueue.deferWatchReports?.(
            id,
            Math.max(
              previous?.messageDebounceMs ?? 0,
              state.watches[id]?.debounceMs ?? 0,
            ),
          );
          if (previous) startMessageTimer(previous);
          throw new AggregateError(
            [error, rollbackError],
            'Conductor message listen registration failed and could not be rolled back.',
          );
        }
        options.dispatchQueue.deferWatchReports?.(
          id,
          Math.max(
            previous?.messageDebounceMs ?? 0,
            state.watches[id]?.debounceMs ?? 0,
          ),
        );
        if (previous) startMessageTimer(previous);
        throw error;
      }
      return listener;
    },
    async unregisterConductorMessageListen(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const removed = await withStateLock(async () => {
        const previous = state.messageListeners[id];
        if (!previous) return false;
        delete state.messageListeners[id];
        const previousCursor = state.messageCursors[id];
        delete state.messageCursors[id];
        deferWatchPendingReports(
          id,
          state.watches[id]?.debounceMs ?? 0,
        );
        try {
          await persist();
        } catch (error) {
          state.messageListeners[id] = previous;
          if (previousCursor !== undefined) state.messageCursors[id] = previousCursor;
          throw error;
        }
        return true;
      });
      if (!removed) return false;
      const timer = messageTimers.get(id);
      if (timer) clearInterval(timer);
      messageTimers.delete(id);
      options.dispatchQueue.deferWatchReports?.(
        id,
        state.watches[id]?.debounceMs ?? 0,
      );
      return true;
    },
    listConductorMessageListens() {
      return Object.values(state.messageListeners).map((listener) => ({
        ...listener,
      }));
    },
    getLiveStatus(conductorAgentId) {
      const status = liveStatuses.get(conductorAgentId);
      if (!status || status.checkedAt === null) return undefined;
      return { ...status };
    },
    listIdleCandidateObservations() {
      return [...new Set([...Object.keys(state.watches), ...autoWatches.keys()])]
        .sort()
        .flatMap((id) => {
          const observation = idleCandidateObservations.get(id);
          return observation ? [{ ...observation }] : [];
        });
    },
    async refreshIdleCandidateObservation(
      conductorAgentId,
      afterObservationVersion,
    ) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const watch = state.watches[id] ?? autoWatches.get(id);
      const assignedWatchStatePath = pathById.get(id);
      const assignedIssueUrl = issueUrlById.get(id);
      if (
        closed ||
        !watch ||
        !assignedWatchStatePath ||
        !assignedIssueUrl
      ) {
        return false;
      }

      const knownVersion =
        afterObservationVersion ??
        idleCandidateObservations.get(id)?.observationVersion ??
        0;
      const isFresh = (observation: OperatorIdleCandidateObservation) => {
        const now = Date.now();
        return observation.checkedAt <= now &&
          now - observation.checkedAt <= Math.max(10_000, observation.pollIntervalMs * 2);
      };
      const currentObservation = idleCandidateObservations.get(id);
      if (
        currentObservation &&
        currentObservation.observationVersion > knownVersion &&
        isFresh(currentObservation)
      ) {
        // A normal poll completed after the gate-clear pass captured its
        // freshness boundary. Reuse that result instead of issuing a second
        // UDS read for the same session.
        return true;
      }
      const inFlightPoll = pollCompletions.get(id);
      if (inFlightPoll) {
        // pollOnce may already own the profile state lock while waiting for
        // UDS. Reuse its observation when it completes; do not let a duplicate
        // poll return early and make the run loop freeze before admission.
        await inFlightPoll;
        const refreshedObservation = idleCandidateObservations.get(id);
        if (
          closed || !(state.watches[id] ?? autoWatches.get(id)) ||
          pathById.get(id) !== assignedWatchStatePath ||
          issueIdentity(issueUrlById.get(id) ?? '') !== issueIdentity(assignedIssueUrl)
        ) return false;
        if (!refreshedObservation || refreshedObservation.observationVersion <= knownVersion) {
          return false;
        }
        if (isFresh(refreshedObservation)) {
          return true;
        }
        // A poll that crossed the gate may have started too long ago to be
        // fresh. Refresh after it completes; never overlap the same poll.
      }

      // Candidate-only freshness must not hold the shared profile state lock
      // across a UDS request. A ready OQ batch still needs that lock to freeze
      // and send within the run loop's aggregate refresh wait cap.
      // Reserve the same per-session slot used by ordinary polls, including
      // while locating the session and validating the completed read.
      if (polling.has(id)) return false;
      polling.add(id);
      let resolveRefreshCompletion!: () => void;
      const refreshCompletion = new Promise<void>((resolve) => {
        resolveRefreshCompletion = resolve;
      });
      pollCompletions.set(id, refreshCompletion);
      try {
        const located = await findSession(id, { root });
        if (
          !located ||
          issueIdentity(located.resumeStore.issueUrl) !==
            issueIdentity(assignedIssueUrl)
        ) {
          return false;
        }
        const {
          snapshot: observation,
          source,
          connectivity,
          checkedAt,
        } = await readObservation(root, located);
        const latestLocated = await findSession(id, { root });
        const phaseObservationIsStable = Boolean(
          source === 'uds' &&
            connectivity === 'reachable' &&
            latestLocated &&
            latestLocated.path === located.path &&
            latestLocated.location === located.location &&
            issueIdentity(latestLocated.resumeStore.issueUrl) ===
              issueIdentity(located.resumeStore.issueUrl) &&
            latestLocated.resumeStore.harnessPhase ===
              located.resumeStore.harnessPhase &&
            latestLocated.resumeStore.modifiedAt ===
              located.resumeStore.modifiedAt &&
            latestLocated.resumeStore.lifecycle ===
              located.resumeStore.lifecycle,
        );
        const currentWatch = state.watches[id] ?? autoWatches.get(id);
        if (
          closed ||
          !currentWatch ||
          pathById.get(id) !== assignedWatchStatePath ||
          issueIdentity(issueUrlById.get(id) ?? '') !==
            issueIdentity(assignedIssueUrl)
        ) {
          return false;
        }
        if (!phaseObservationIsStable) {
          idleCandidateObservations.delete(id);
          return false;
        }

        idleCandidateObservations.set(id, {
          conductorAgentId: id,
          issueUrl: located.resumeStore.issueUrl,
          observationVersion: ++idleCandidateObservationVersion,
          source,
          connectivity,
          checkedAt,
          pollIntervalMs: currentWatch.pollIntervalMs,
          harnessPhase: located.resumeStore.harnessPhase,
          harnessModifiedAt: located.resumeStore.modifiedAt,
          ...(located.resumeStore.lifecycle !== undefined
            ? { lifecycle: located.resumeStore.lifecycle }
            : {}),
          openQuestionCount: observation.openQuestions.filter(
            (question) => question.status === 'open',
          ).length,
          ...(observation.sessionState?.current
            ? {
                statusLine: {
                  text: observation.sessionState.current.statusLine,
                  reportedAt: observation.sessionState.current.reportedAt,
                },
              }
            : {}),
        });
        return true;
      } finally {
        polling.delete(id);
        if (pollCompletions.get(id) === refreshCompletion) {
          pollCompletions.delete(id);
        }
        resolveRefreshCompletion();
      }
    },
    async pollOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      if (closed || polling.has(id)) return 0;
      polling.add(id);
      let resolvePollCompletion!: () => void;
      const pollCompletion = new Promise<void>((resolve) => {
        resolvePollCompletion = resolve;
      });
      pollCompletions.set(id, pollCompletion);
      try {
        return await withStateLock(async (nextArrivalOrder) => {
          const watch = state.watches[id] ?? autoWatches.get(id);
          if (!watch || closed) return 0;
          let located: LocatedSessionResumeStore | undefined;
          try {
            located = await locateSession(id);
          } catch (error) {
            if (isAmbiguousResumeStoreError(error)) {
              idleCandidateObservations.delete(id);
              return 0;
            }
            throw error;
          }
          if (!located) {
            idleCandidateObservations.delete(id);
            return 0;
          }
          const binding = bindLocatedSession(id, located);
          if (!binding.assigned) {
            idleCandidateObservations.delete(id);
            return 0;
          }
          const {
            snapshot: observation,
            source,
            connectivity,
            checkedAt,
          } = await readObservation(root, located);
          const resumeStore = located.resumeStore;
          let phaseObservationIsStable = false;
          if (source === 'uds' && connectivity === 'reachable') {
            const latestLocated = await locateSession(id);
            if (
              !latestLocated ||
              latestLocated.path !== located.path ||
              latestLocated.location !== located.location ||
              latestLocated.resumeStore.issueUrl !== resumeStore.issueUrl
            ) {
              idleCandidateObservations.delete(id);
              return 0;
            }
            phaseObservationIsStable = Boolean(
              latestLocated.resumeStore.harnessPhase ===
                resumeStore.harnessPhase &&
                latestLocated.resumeStore.modifiedAt === resumeStore.modifiedAt &&
                latestLocated.resumeStore.lifecycle === resumeStore.lifecycle,
            );
          }
          const previousLiveStatus = liveStatuses.get(id);
          if (
            phaseObservationIsStable &&
            resumeStore.harnessPhase !== undefined &&
            resumeStore.modifiedAt !== undefined
          ) {
            idleCandidateObservations.set(id, {
              conductorAgentId: id,
              issueUrl: resumeStore.issueUrl,
              observationVersion: ++idleCandidateObservationVersion,
              source,
              connectivity,
              checkedAt,
              pollIntervalMs: watch.pollIntervalMs,
              harnessPhase: resumeStore.harnessPhase,
              harnessModifiedAt: resumeStore.modifiedAt,
              ...(resumeStore.lifecycle !== undefined
                ? { lifecycle: resumeStore.lifecycle }
                : {}),
              openQuestionCount: observation.openQuestions.filter(
                (question) => question.status === 'open',
              ).length,
              ...(observation.sessionState?.current
                ? {
                    statusLine: {
                      text: observation.sessionState.current.statusLine,
                      reportedAt: observation.sessionState.current.reportedAt,
                    },
                  }
                : {}),
            });
          } else {
            idleCandidateObservations.delete(id);
          }
          liveStatuses.set(id, {
            connectivity,
            checkedAt,
            ...(source === 'uds' ? { snapshot: observation } : {}),
            unreachableSince:
              connectivity === 'unreachable'
                ? previousLiveStatus?.connectivity === 'unreachable'
                  ? previousLiveStatus.unreachableSince ?? checkedAt
                  : checkedAt
                : null,
          });
          const previous = state.cursors[id];
          const next = cursorFor(observation, checkedAt, source, previous);
          const debounceMs = Math.max(
            watch.debounceMs,
            state.messageListeners[id]?.messageDebounceMs ?? 0,
          );
          const queuedAt = Date.now();
          const readyAt = queuedAt + debounceMs;
          const reports = collectReports(
            resumeStore,
            observation,
            previous,
            source,
          ).map((report) => ({
            ...report,
            reportId: randomUUID(),
            conductorAgentId: id,
            issueUrl: resumeStore.issueUrl,
            debounceMs,
            readyAt,
            arrivalOrder: nextArrivalOrder(),
            firstQueuedAt: queuedAt,
            priority:
              report.reportType === 'open_question'
                ? 'open_question' as const
                : 'normal' as const,
          }));
          const cursorChanged = hash(previous ?? null) !== hash(next);
          if (reports.length > 0) {
            retainReadyBatch(id, queuedAt);
            state.pendingReports.push(...reports);
          }
          state.cursors[id] = next;
          if (reports.length > 0 || cursorChanged) await persist();
          return reports.length;
        });
      } catch (error) {
        idleCandidateObservations.delete(id);
        throw error;
      } finally {
        polling.delete(id);
        if (pollCompletions.get(id) === pollCompletion) {
          pollCompletions.delete(id);
        }
        resolvePollCompletion();
      }
    },
    async pollConductorMessagesOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      if (closed || messagePolling.has(id)) return 0;
      messagePolling.add(id);
      try {
        return await withStateLock(async (nextArrivalOrder) => {
          const listener = state.messageListeners[id];
          if (!listener || closed) return 0;
          let located: LocatedSessionResumeStore | undefined;
          try {
            located = await locateSession(id);
          } catch (error) {
            if (isAmbiguousResumeStoreError(error)) return 0;
            throw error;
          }
          const resumeStore = located?.resumeStore;
          if (!resumeStore?.harnessSocketPath) return 0;
          const binding = bindLocatedSession(id, located!);
          if (!binding.assigned) return 0;
          const cursor = state.messageCursors[id];
          if (cursor === undefined) {
            state.messageCursors[id] = await readConductorMessageBaseline(
              resumeStore.harnessSocketPath,
            );
            await persist();
            return 0;
          }
          const readResult = await readConductorMessagePages(
            resumeStore.harnessSocketPath,
            cursor,
          );
          const messages = readResult.messages;
          if (
            messages.length === 0 &&
            readResult.oversizedSendCounts.length === 0 &&
            readResult.responseSizeError
          ) {
            throw readResult.responseSizeError;
          }
          const nextCursor = readResult.cursor;
          const messageEvents = [
            ...messages.map((message) => ({
              type: 'message' as const,
              sendCount: message.sendCount,
              message,
            })),
            ...readResult.oversizedSendCounts.map((sendCount) => ({
              type: 'oversized' as const,
              sendCount,
            })),
          ].sort((left, right) => left.sendCount - right.sendCount);
          const reports: OperatorWatchState['pendingReports'] = [];
          const queuedAt = Date.now();
          const readyAt = queuedAt + listener.messageDebounceMs;
          for (let index = 0; index < messageEvents.length; ) {
            const event = messageEvents[index]!;
            if (event.type === 'message') {
              reports.push({
                reportId: randomUUID(),
                reportType: 'conductor_message',
                conductorAgentId: id,
                issueUrl: resumeStore.issueUrl,
                text: formatConductorMessageReport(resumeStore, event.message),
                debounceMs: listener.messageDebounceMs,
                readyAt,
                arrivalOrder: nextArrivalOrder(),
                firstQueuedAt: queuedAt,
                priority: 'normal',
                sendCount: event.sendCount,
              });
              index += 1;
              continue;
            }

            const oversizedSendCounts: number[] = [];
            while (
              messageEvents[index]?.type === 'oversized'
            ) {
              oversizedSendCounts.push(messageEvents[index]!.sendCount);
              index += 1;
            }
            reports.push({
              reportId: randomUUID(),
              reportType: 'conductor_message',
              conductorAgentId: id,
              issueUrl: resumeStore.issueUrl,
              text: formatOversizedConductorMessageWarning(
                resumeStore.issueUrl,
                id,
                oversizedSendCounts,
              ),
              debounceMs: listener.messageDebounceMs,
              readyAt,
              arrivalOrder: nextArrivalOrder(),
              firstQueuedAt: queuedAt,
              priority: 'normal',
              sendCount: oversizedSendCounts.at(-1)!,
              oversizedSendCounts,
            });
          }
          reports.sort(
            (left, right) =>
              (left.sendCount ?? 0) - (right.sendCount ?? 0),
          );
          state.messageCursors[id] = nextCursor;
          if (reports.length > 0) {
            retainReadyBatch(id, queuedAt);
            for (const pending of state.pendingReports) {
              if (
                pending.conductorAgentId === id &&
                !pending.frozenBatchId
              ) pending.readyAt = readyAt;
            }
            state.pendingReports.push(...reports);
          }
          if (reports.length > 0 || nextCursor !== cursor) await persist();
          if (readResult.responseSizeError) {
            throw readResult.responseSizeError;
          }
          return reports.length;
        });
      } finally {
        messagePolling.delete(id);
      }
    },
    refreshPendingReports,
    async acknowledge(events) {
      const acknowledged = new Set(
        events.flatMap((event) =>
          event.type === 'report' && event.reportId ? [event.reportId] : [],
        ),
      );
      if (acknowledged.size === 0) return;
      await withStateLock(async () => {
        const remaining = state.pendingReports.filter(
          (report) => !acknowledged.has(report.reportId),
        );
        if (remaining.length === state.pendingReports.length) return;
        state.pendingReports = remaining;
        await persist();
      });
      options.dispatchQueue.discardQueuedReports?.([...acknowledged]);
    },
    async enqueueIdleCandidate(input) {
      const conductorAgentId = requireNonEmptyString(
        input.conductorAgentId,
        'conductorAgentId',
      );
      const text = requireNonEmptyString(input.text, 'text');
      const issueUrl = issueUrlById.get(conductorAgentId);
      if (!issueUrl) {
        throw new Error(
          `Cannot enqueue an idle candidate for unassigned session ${conductorAgentId}.`,
        );
      }
      const reportId = randomUUID();
      const fingerprint = requireNonEmptyString(
        input.fingerprint,
        'fingerprint',
      );
      const admitted = await withStateLock(async (nextArrivalOrder) => {
        if (input.shouldAdmit && !input.shouldAdmit()) return false;
        const fingerprints =
          (state.idleCandidateFingerprints[conductorAgentId] ??= {});
        if (fingerprints[input.kind] === fingerprint) return false;
        const queuedAt = Date.now();
        const previousFingerprint = fingerprints[input.kind];
        fingerprints[input.kind] = fingerprint;
        retainReadyBatch(conductorAgentId, queuedAt);
        state.pendingReports.push({
          reportId,
          reportType: 'idle_candidate',
          conductorAgentId,
          issueUrl,
          text,
          debounceMs: 0,
          readyAt: queuedAt,
          arrivalOrder: nextArrivalOrder(),
          firstQueuedAt: queuedAt,
          priority: 'idle',
          // Eligibility begins when this process can actually admit the
          // candidate to the shared scheduler, after acquiring the profile
          // state lock. A caller-supplied timestamp must not age it while it
          // waits outside the scheduler.
          eligibleAt: queuedAt,
        });
        try {
          await persist();
        } catch (error) {
          state.pendingReports = state.pendingReports.filter(
            (report) => report.reportId !== reportId,
          );
          if (previousFingerprint === undefined) {
            delete fingerprints[input.kind];
            if (Object.keys(fingerprints).length === 0) {
              delete state.idleCandidateFingerprints[conductorAgentId];
            }
          } else {
            fingerprints[input.kind] = previousFingerprint;
          }
          throw error;
        }
        return true;
      });
      return admitted ? reportId : undefined;
    },
    async commitBatch(batch, dispatchState) {
      // User input and already frozen retries do not need a new manifest.
      if (batch.sourceKey === 'user' || batch.batchId) {
        if (batch.batchId && dispatchState &&
            !options.dispatchQueue.isBatchCurrent(batch, dispatchState)) {
          return false;
        }
        return options.dispatchQueue.commitBatch(batch);
      }
      let committed = false;
      let durable = false;
      try {
        return await withStateLock(async () => {
          // Do not reconcile the refreshed durable state into the local queue:
          // reports from peers that are not yet locally visible belong to the
          // next batch. Capture local arrivals only after acquiring the lock.
          if (
            dispatchState &&
            !options.dispatchQueue.isBatchCurrent(batch, dispatchState)
          ) {
            return false;
          }
          return options.dispatchQueue.commitBatch(batch, () => {
            committed = true;
            const reports = batch.events.filter(
              (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
                event.type === 'report' && event.reportId !== undefined,
            );
            if (reports.length === 0) return;
            if (!batch.batchId || !batch.payload) {
              throw new Error('A committed report batch must have a frozen id and payload.');
            }
            const reportsById = new Map(
              state.pendingReports.map((report) => [report.reportId, report]),
            );
            for (const event of reports) {
              const stored = reportsById.get(event.reportId!);
              if (!stored) {
                throw new Error(
                  `Pending report ${event.reportId} disappeared before its batch could be frozen.`,
                );
              }
              stored.arrivalOrder = event.arrivalOrder ?? stored.arrivalOrder;
              stored.firstQueuedAt = event.firstQueuedAt ?? stored.firstQueuedAt;
              stored.readyAt = event.readyAt;
              stored.priority = event.priority ?? stored.priority;
              stored.eligibleAt = event.eligibleAt ?? stored.eligibleAt;
              stored.frozenBatchId = batch.batchId;
              stored.frozenPayload = batch.payload;
              delete stored.retryReadyAt;
            }
            const path = pathById.get(reports[0]!.conductorAgentId);
            if (!path) throw new Error('Cannot persist a batch without its session state path.');
            const partitions = partitionWatchState(state, pathById, issueUrlById);
            const partition = partitions.get(path);
            if (!partition) throw new Error('Cannot persist a batch without its session state.');
            const retained = unassignedStateByPath.get(path);
            // Synchronous atomic replacement makes the local capture and durable
            // freeze one event-loop operation: no report can arrive in between.
            saveWatchStateSync(path, retained ? mergeWatchStates(partition, retained) : partition);
            durable = true;
            statePaths.add(path);
          });
        }, false);
      } catch (error) {
        // Once the manifest reached disk, an uncertain lock release must not
        // unfreeze it locally. Restart can replay the durable batch unchanged.
        if (committed && !durable) options.dispatchQueue.rollbackBatchCommit(batch);
        throw error;
      }
    },
    async recordRetry(events, retryReadyAt) {
      const reports = events.filter(
        (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
          event.type === 'report' && event.reportId !== undefined,
      );
      if (reports.length === 0) return;
      await withStateLock(async () => {
        const reportsById = new Map(
          state.pendingReports.map((report) => [report.reportId, report]),
        );
        for (const event of reports) {
          const stored = reportsById.get(event.reportId!);
          if (stored) stored.retryReadyAt = retryReadyAt;
        }
        await persist();
      });
    },
    async scanAutoSessionsOnce() {
      if (closed || autoScanInFlight) return;
      autoScanInFlight = true;
      try {
        const candidates = new Map<string, LocatedSessionResumeStore[]>();
        let cursor: string | undefined;
        do {
          const page = await listUserLocatedSessionResumeStoresPage(
            { limit: 500, ...(cursor ? { cursor } : {}) },
            { userEnsembleRoot: root, onDuplicate: onResumeStoreDuplicate },
          );
          for (const located of page.sessions) {
            const store = located.resumeStore;
            const repository = repositoryForIssue(store.issueUrl);
            if (!store.harnessSocketPath || !repository || !repositoryIsInActiveScope(repository)) continue;
            const matches = candidates.get(store.conductorAgentId) ?? [];
            matches.push(located);
            candidates.set(store.conductorAgentId, matches);
          }
          cursor = page.nextCursor;
        } while (cursor && !closed);
        const entries = [...candidates].filter(([, matches]) => matches.length === 1);
        const retained = new Set<string>();
        for (let index = 0; index < entries.length && !closed; index += 8) {
          await Promise.all(entries.slice(index, index + 8).map(async ([id, matches]) => {
            const located = matches[0]!;
            try {
              await sendOpenQuestionControlRequest<SessionObservationSnapshot>(
                located.resumeStore.harnessSocketPath!,
                { method: OPEN_QUESTION_CONTROL_METHODS.observe },
                { timeoutMs: 1_000 },
              );
              if (closed) return;
              retained.add(id);
              if (!autoWatches.has(id)) {
                autoWatches.set(id, { conductorAgentId: id, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, debounceMs: 250 });
              }
            } catch (error) {
              if (!(error instanceof OpenQuestionControlTransportError && error.reason === 'connection') &&
                  autoWatches.has(id)) retained.add(id);
            }
          }));
        }
        if (closed) return;
        for (const id of autoWatches.keys()) {
          if (!retained.has(id)) {
            autoWatches.delete(id);
            if (!state.watches[id]) idleCandidateObservations.delete(id);
          }
        }
        for (const [id, timer] of timers) {
          if (!state.watches[id] && !autoWatches.has(id)) {
            clearInterval(timer);
            timers.delete(id);
          }
        }
        for (const [id, watch] of autoWatches) {
          if (!timers.has(id)) startTimer(state.watches[id] ?? watch);
        }
        await Promise.all([...retained].filter((id) => !state.watches[id]).map((id) =>
          pool.pollOnce(id).catch((error: unknown) => {
            options.onError?.(formatWatchPollError(id, error));
            return 0;
          })));
      } finally {
        autoScanInFlight = false;
      }
    },
    close() {
      closed = true;
      if (autoScanTimer) clearInterval(autoScanTimer);
      autoWatches.clear();
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      for (const timer of repositoryTimers.values()) clearInterval(timer);
      repositoryTimers.clear();
      for (const timer of messageTimers.values()) clearInterval(timer);
      messageTimers.clear();
      if (pendingReportRefreshTimer) clearInterval(pendingReportRefreshTimer);
      pendingReportRefreshTimer = undefined;
    },
  };

  pendingReportRefreshTimer = setInterval(() => {
    if (closed || pendingReportRefreshInFlight) return;
    pendingReportRefreshInFlight = true;
    void refreshPendingReports().catch((error: unknown) => {
      options.onError?.(
        formatPendingReportRefreshError(error),
      );
    }).finally(() => {
      pendingReportRefreshInFlight = false;
    });
  }, PENDING_REPORT_REFRESH_INTERVAL_MS);
  pendingReportRefreshTimer.unref();
  await withStateLock(async () => {
    reconcileRepositoryAutoWatches();
    await persist();
  });
  for (const watch of pool.list()) startTimer(watch);
  for (const listener of pool.listConductorMessageListens()) {
    startMessageTimer(listener);
  }
  syncRepositoryWatchTimers();
  if (options.autoDiscoverSessions) {
    const scan = () => void pool.scanAutoSessionsOnce().catch((error: unknown) =>
      options.onError?.(`automatic session scan failed: ${error instanceof Error ? error.message : String(error)}`));
    autoScanTimer = setInterval(scan, 30_000);
    autoScanTimer.unref();
    scan();
  }
  void pool.scanRepositoriesOnce().catch((error: unknown) => {
    options.onError?.(
      `repository watch startup scan failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return pool;
}

export function createRegisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_session_watch',
    description:
      'Register a persistent manual watch for a saved Issue session, independently of live automatic discovery and the repository-watch limit. Reports new open questions, open-to-answered transitions, and disappearance from the observed question list. Each report identifies whether it came from live harness UDS or saved SessionResumeStore/YAML. answeredBy: operator records the operator role and does not distinguish a human on the Issue TTY from operator-agent; only answeredBy: conductor means a conductor-side answer. A question disappearing from the list without answer data is unconfirmed, not resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        pollIntervalMs: {
          type: 'integer',
          minimum: MIN_POLL_INTERVAL_MS,
          maximum: MAX_POLL_INTERVAL_MS,
          description: 'Per-session polling interval in milliseconds (default 2000).',
        },
        debounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_DEBOUNCE_MS,
          description:
            'Watch report quiet window in milliseconds (default 250). When conductor-message listen is active, watch reports also wait for its messageDebounceMs window.',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const watch = await pool.register(
        requireToolString(args.conductorAgentId, 'conductorAgentId'),
        {
          pollIntervalMs: optionalNumber(args.pollIntervalMs, 'pollIntervalMs'),
          debounceMs: optionalNumber(args.debounceMs, 'debounceMs'),
        },
      );
      return toolResult(watch as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_session_watch',
    description: 'Remove the saved session watch registration. If it belongs to a repository watch, suppress its repository-driven automatic re-registration. removed is false when no saved registration exists, including a live-discovery-only watch. Independent live automatic discovery is not disabled: a live watch may remain active or resume on a later scan, even when removed is true. Do not report that all monitoring has stopped based on this result alone; inspect the session watch status.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireToolString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const removed = await pool.unregister(conductorAgentId);
      return toolResult({ conductorAgentId, removed });
    },
  };
}

export function createRegisterRepositoryWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_repository_watch',
    description:
      'Enable a profile-scoped watch for one exact GitHub owner/repo. A profile can register up to 20 repositories; registering a new repository beyond that limit fails, while registering an existing repository updates its settings. Separately, repository-driven automatic session watches are limited to 20 runs per profile; independent live automatic discovery and manual session watches are outside that limit. Existing saved runs become the baseline and are eligible for automatic watch; later runs are discovered on the repository scan interval. Registration and first-observed times survive operator-agent restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        githubRepo: {
          type: 'string',
          description: 'Exact GitHub repository in owner/repo form.',
        },
        scanIntervalMs: {
          type: 'integer',
          minimum: MIN_REPOSITORY_SCAN_INTERVAL_MS,
          maximum: MAX_REPOSITORY_SCAN_INTERVAL_MS,
          description: 'Repository discovery interval (default 30000).',
        },
        pollIntervalMs: {
          type: 'integer',
          minimum: MIN_POLL_INTERVAL_MS,
          maximum: MAX_POLL_INTERVAL_MS,
          description: 'Repository-driven session watch polling interval in milliseconds (default 10000).',
        },
        debounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_DEBOUNCE_MS,
          description: 'Watch report quiet window (default 250).',
        },
      },
      required: ['githubRepo'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const config = await pool.registerRepository(
        requireToolString(args.githubRepo, 'githubRepo'),
        {
          scanIntervalMs: optionalNumber(args.scanIntervalMs, 'scanIntervalMs'),
          pollIntervalMs: optionalNumber(args.pollIntervalMs, 'pollIntervalMs'),
          debounceMs: optionalNumber(args.debounceMs, 'debounceMs'),
        },
      );
      return toolResult({
        ...config,
        baselineRunCount: config.managedSessionIds.length +
          config.manualSessionIds.length,
        autoWatchLimit: MAX_REPOSITORY_AUTO_WATCHES,
      } as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterRepositoryWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_repository_watch',
    description:
      'Remove the repository watch registration, stopping its scans and repository-managed session watches. Explicit manual watches and independent live automatic discovery are unaffected; a live watch may remain active or resume, even when removed is true. Do not report that all monitoring has stopped based on this result alone; inspect the session watch status. First-observed history is retained for future registration.',
    inputSchema: {
      type: 'object',
      properties: {
        githubRepo: {
          type: 'string',
          description: 'Exact GitHub repository in owner/repo form.',
        },
      },
      required: ['githubRepo'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const githubRepo = requireToolString(args.githubRepo, 'githubRepo');
      const removed = await pool.unregisterRepository(githubRepo);
      return toolResult({ githubRepo, removed });
    },
  };
}

export function createRegisterConductorMessageListenTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_conductor_message_listen',
    description:
      'Listen for new successful conductor responses from a running Issue session. The first live poll establishes a baseline; subsequent messages are polled over UDS and debounced into one report. Related watch reports for the same session share this quiet window. No offline fallback is used.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        messageDebounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_MESSAGE_DEBOUNCE_MS,
          description:
            'Quiet period in milliseconds before nearby conductor responses are reported (default 10000).',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const listener = await pool.registerConductorMessageListen(
        requireToolString(args.conductorAgentId, 'conductorAgentId'),
        {
          messageDebounceMs: optionalNumber(
            args.messageDebounceMs,
            'messageDebounceMs',
          ),
        },
      );
      return toolResult(listener as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterConductorMessageListenTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_conductor_message_listen',
    description: 'Stop listening for conductor responses from an Issue session.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireToolString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const removed = await pool.unregisterConductorMessageListen(
        conductorAgentId,
      );
      return toolResult({ conductorAgentId, removed });
    },
  };
}

async function readConductorMessages(
  socketPath: string,
  params: {
    limit: number;
    order: 'asc' | 'desc';
    after?: number;
  },
): Promise<{
  messages: OpenQuestionControlConductorMessage[];
  hasMore: boolean;
}> {
  return sendOpenQuestionControlRequest(socketPath, {
    method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
    params,
  });
}

async function readConductorMessageBaseline(socketPath: string): Promise<number> {
  try {
    const baseline = await readConductorMessages(socketPath, {
      limit: 1,
      order: 'desc',
    });
    return baseline.messages[0]?.sendCount ?? 0;
  } catch (error) {
    const oversizedSendCount = oversizedConductorMessageSendCount(error);
    if (oversizedSendCount !== undefined) return oversizedSendCount;
    throw error;
  }
}

async function readConductorMessagePages(
  socketPath: string,
  cursor: number,
): Promise<{
  messages: OpenQuestionControlConductorMessage[];
  oversizedSendCounts: number[];
  cursor: number;
  responseSizeError?: OpenQuestionControlRemoteError;
}> {
  const messages: OpenQuestionControlConductorMessage[] = [];
  const oversizedSendCounts: number[] = [];
  let after = cursor;
  let limit = CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT;

  while (true) {
    let page: Awaited<ReturnType<typeof readConductorMessages>>;
    try {
      page = await readConductorMessages(socketPath, {
        limit,
        order: 'asc',
        after,
      });
    } catch (error) {
      if (!isConductorMessageResponseTooLarge(error)) throw error;
      if (limit === 1) {
        const oversizedSendCount =
          oversizedConductorMessageSendCount(error);
        if (
          oversizedSendCount === undefined ||
          oversizedSendCount <= after
        ) {
          return {
            messages,
            oversizedSendCounts,
            cursor: after,
            responseSizeError: error,
          };
        }
        oversizedSendCounts.push(oversizedSendCount);
        after = oversizedSendCount;
        limit = CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT;
        continue;
      }
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }

    const nextMessages = page.messages
      .filter((message) => message.sendCount > after)
      .sort((left, right) => left.sendCount - right.sendCount);
    if (nextMessages.length === 0) {
      return { messages, oversizedSendCounts, cursor: after };
    }
    messages.push(...nextMessages);
    after = nextMessages.at(-1)!.sendCount;
    if (!page.hasMore) {
      return { messages, oversizedSendCounts, cursor: after };
    }
  }
}

function isConductorMessageResponseTooLarge(
  error: unknown,
): error is OpenQuestionControlRemoteError {
  return (
    error instanceof OpenQuestionControlRemoteError &&
    error.rpcCode === -32603 &&
    error.message === 'Response is too large.'
  );
}

function oversizedConductorMessageSendCount(
  error: unknown,
): number | undefined {
  if (
    !isConductorMessageResponseTooLarge(error) ||
    !error.data ||
    !('oversizedSendCount' in error.data)
  ) {
    return undefined;
  }
  return error.data.oversizedSendCount;
}

function formatConductorMessageReport(
  resumeStore: SessionResumeStore,
  message: OpenQuestionControlConductorMessage,
): string {
  return [
    `対象: ${resumeStore.issueUrl} (${resumeStore.conductorAgentId})`,
    `sendCount: ${message.sendCount}`,
    `at: ${new Date(message.at).toISOString()}`,
    ...(message.dispatchSource
      ? [`dispatchSource: ${message.dispatchSource}`]
      : []),
    '',
    '#### inbound',
    '',
    message.inbound,
    '',
    '#### response',
    '',
    message.text,
  ].join('\n');
}

async function readObservation(
  repoRoot: string,
  located: LocatedSessionResumeStore,
): Promise<{
  snapshot: SessionObservationSnapshot;
  source: 'uds' | 'resume_store';
  connectivity: OperatorSessionLiveStatus['connectivity'];
  checkedAt: number;
}> {
  // The snapshot can already be old when the response or later store reads
  // finish. Use the request start as a conservative freshness boundary.
  const checkedAt = Date.now();
  const { resumeStore } = located;
  if (resumeStore.harnessSocketPath) {
    try {
      return {
        snapshot: await sendOpenQuestionControlRequest<SessionObservationSnapshot>(
          resumeStore.harnessSocketPath,
          { method: OPEN_QUESTION_CONTROL_METHODS.observe },
        ),
        source: 'uds',
        connectivity: 'reachable',
        checkedAt,
      };
    } catch (error) {
      if (
        !(error instanceof OpenQuestionControlTransportError) &&
        !(
          error instanceof OpenQuestionControlRemoteError &&
          error.rpcCode === -32601
        )
      ) {
        throw error;
      }
      // A recorded socket path is only an index. When it is stale/unreachable,
      // or an older server does not implement snapshots, mark persisted data
      // as the observation source instead of presenting it as live.
      const connectivity =
        error instanceof OpenQuestionControlTransportError && error.reason === 'connection'
          ? 'unreachable'
          : 'unknown';
      const questions = await loadPersistedOpenQuestions(
        repoRoot,
        located,
      );
      const sessionState = await loadPersistedSessionState(
        repoRoot,
        located,
      );
      return {
        snapshot: {
          sequence: questions?.sequence ?? resumeStore.sequence,
          openQuestions: questions?.openQuestions ?? resumeStore.openQuestions,
          ...(sessionState ? { sessionState } : {}),
        },
        source: 'resume_store',
        connectivity,
        checkedAt,
      };
    }
  }
  const questions = await loadPersistedOpenQuestions(
    repoRoot,
    located,
  );
  const sessionState = await loadPersistedSessionState(
    repoRoot,
    located,
  );
  return {
    snapshot: {
      sequence: questions?.sequence ?? resumeStore.sequence,
      openQuestions: questions?.openQuestions ?? resumeStore.openQuestions,
      ...(sessionState ? { sessionState } : {}),
    },
    source: 'resume_store',
    connectivity: 'unknown',
    checkedAt,
  };
}

async function loadPersistedOpenQuestions(
  repoRoot: string,
  located: LocatedSessionResumeStore,
) {
  const paths = userSessionSnapshotPaths(repoRoot, located, 'open-questions');
  for (const path of paths) {
    const snapshot = await loadOpenQuestionsStore(path);
    if (snapshot) return snapshot;
  }
  return undefined;
}

async function loadPersistedSessionState(
  repoRoot: string,
  located: LocatedSessionResumeStore,
) {
  const paths = userSessionSnapshotPaths(repoRoot, located, 'session-state');
  for (const path of paths) {
    const state = await loadSessionStateStore(path);
    if (state) return state;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function collectReports(
  resumeStore: SessionResumeStore,
  observation: SessionObservationSnapshot,
  previous: SessionCursor | undefined,
  source: 'uds' | 'resume_store',
): Array<{ reportType: 'session_state' | 'open_question'; text: string }> {
  const reports: Array<{
    reportType: 'session_state' | 'open_question';
    text: string;
  }> = [];
  const issue = `${resumeStore.issueUrl} (${resumeStore.conductorAgentId})`;
  const observationSource =
    source === 'uds' ? '稼働中 UDS' : '保存済み SessionResumeStore / YAML';

  const currentQuestionIds = new Set(
    observation.openQuestions.map((question) => question.id),
  );
  const questionChanges: Array<{
    askedAt: number;
    id: string;
    kind: 'new' | 'answered' | 'disappeared';
    question: string;
    details?: SessionObservationSnapshot['openQuestions'][number];
    previousStatusUnknown?: boolean;
  }> = [];

  for (const question of observation.openQuestions) {
    const previousQuestion = previous?.questionSnapshots?.[question.id];
    const wasKnown = previous?.questionFingerprints[question.id] !== undefined;
    if (previous && !wasKnown && question.status === 'open') {
      questionChanges.push({
        askedAt: question.askedAt,
        id: question.id,
        kind: 'new',
        question: question.question,
        details: question,
      });
    } else if (
      question.status === 'answered' &&
      (previousQuestion?.status === 'open' ||
        (!previousQuestion &&
          previous?.questionFingerprints[question.id] ===
            fingerprintAsOpen(question)))
    ) {
      questionChanges.push({
        askedAt: question.askedAt,
        id: question.id,
        kind: 'answered',
        question: question.question,
        details: question,
      });
    }
  }

  for (const id of Object.keys(previous?.questionFingerprints ?? {})) {
    if (currentQuestionIds.has(id)) continue;
    const question = previous?.questionSnapshots?.[id];
    if (question && question.status !== 'open') continue;
    questionChanges.push({
      askedAt: question?.askedAt ?? Number.MAX_SAFE_INTEGER,
      id,
      kind: 'disappeared',
      question:
        question?.question ??
        '前回の質問文は旧 cursor に保存されていません',
      ...(!question ? { previousStatusUnknown: true } : {}),
    });
  }

  questionChanges.sort(
    (left, right) =>
      compareQuestionIds(left.id, right.id) || left.askedAt - right.askedAt,
  );
  for (const change of questionChanges) {
    if (change.kind === 'new') {
      reports.push({
        reportType: 'open_question',
        text: [
          `対象: ${issue} / 観測元: ${observationSource}`,
          `新規追加: ${change.id} / ${change.details!.responseType}`,
          `質問: ${formatQuestionSummary(change.question)}`,
          ...(change.details?.context
            ? [`context: ${formatQuestionSummary(change.details.context)}`]
            : []),
        ].join('\n'),
      });
      continue;
    }

    if (change.kind === 'disappeared') {
      reports.push({
        reportType: 'open_question',
        text: [
          `対象: ${issue} / 観測元: ${observationSource}`,
          `一覧から消失: ${change.id}`,
          `質問: ${formatQuestionSummary(change.question)}`,
          ...(change.previousStatusUnknown
            ? ['前回の status: 旧 cursor のため不明']
            : []),
          '回答・回答者: 今回の snapshot では確認できません',
        ].join('\n'),
      });
      continue;
    }

    const question = change.details!;
    reports.push({
      reportType: 'open_question',
      text: [
        `対象: ${issue} / 観測元: ${observationSource}`,
        `解決: ${question.id}`,
        `質問: ${formatQuestionSummary(question.question)}`,
        ...(question.answer
          ? [`回答: ${formatQuestionSummary(question.answer)}`]
          : []),
        ...(question.assent ? [`賛否: ${question.assent}`] : []),
        ...(question.selectedChoice
          ? [`選択肢: ${formatQuestionSummary(question.selectedChoice)}`]
          : []),
        ...(question.answer || question.assent || question.selectedChoice
          ? []
          : ['回答内容: snapshot に記録されていません']),
        ...(question.answeredBy
          ? [`answeredBy: ${question.answeredBy}`]
          : []),
        ...(question.answeredAt !== undefined
          ? [`answeredAt: ${formatQuestionTimestamp(question.answeredAt)}`]
          : []),
      ].join('\n'),
    });
  }

  const statusEntries = observation.sessionState
    ? [...observation.sessionState.history, observation.sessionState.current]
    : [];
  const changedStatuses = statusEntries.filter((status) => {
    const fingerprint = hash(status);
    return previous?.statusFingerprints[String(status.reportedAt)] !== fingerprint;
  });
  const firstPoll = !previous;
  const selectedStatuses = firstPoll ? changedStatuses.slice(-1) : changedStatuses;
  for (const status of selectedStatuses) {
    reports.push({
      reportType: 'session_state',
      text: [
        `対象: ${issue} / 観測元: ${observationSource}`,
        `状態 (${new Date(status.reportedAt).toISOString()}): ${status.statusLine}`,
      ].join('\n'),
    });
  }
  return reports;
}

function cursorFor(
  observation: SessionObservationSnapshot,
  checkedAt?: number,
  source?: 'uds' | 'resume_store',
  previous?: SessionCursor,
): SessionCursor {
  const questionFingerprints: Record<string, string> = {};
  const questionSnapshots: NonNullable<SessionCursor['questionSnapshots']> = {};
  for (const question of observation.openQuestions) {
    questionFingerprints[question.id] = hash(question);
    questionSnapshots[question.id] = {
      question: question.question,
      status: question.status,
      askedAt: question.askedAt,
    };
  }
  const statusFingerprints: Record<string, string> = {};
  if (observation.sessionState) {
    for (const status of [
      ...observation.sessionState.history,
      observation.sessionState.current,
    ]) {
      statusFingerprints[String(status.reportedAt)] = hash(status);
    }
  }
  return {
    sequence: observation.sequence,
    questionFingerprints,
    questionSnapshots,
    statusFingerprints,
    ...(checkedAt !== undefined && source !== undefined
      ? {
          questionCountObservation: {
            metric: 'unanswered_open_questions',
            current: {
              count: observation.openQuestions.filter(
                (question) => question.status === 'open',
              ).length,
              checkedAt,
              source,
            },
            ...(previous?.questionCountObservation
              ? {
                  previous:
                    previous.questionCountObservation.current,
                }
              : {}),
          },
        }
      : previous?.questionCountObservation
        ? {
            questionCountObservation:
              previous.questionCountObservation,
          }
        : {}),
  };
}

function compareQuestionIds(left: string, right: string): number {
  const leftSequence = /^inq-(\d+)$/.exec(left)?.[1];
  const rightSequence = /^inq-(\d+)$/.exec(right)?.[1];
  if (leftSequence && rightSequence) {
    return Number(leftSequence) - Number(rightSequence);
  }
  return left.localeCompare(right);
}

function fingerprintAsOpen(
  question: SessionObservationSnapshot['openQuestions'][number],
): string {
  const openQuestion = { ...question, status: 'open' as const };
  delete openQuestion.answer;
  delete openQuestion.assent;
  delete openQuestion.selectedChoice;
  delete openQuestion.approved;
  delete openQuestion.answeredAt;
  delete openQuestion.answeredBy;
  delete openQuestion.sourceMessage;
  delete openQuestion.rationale;
  return hash(openQuestion);
}

function formatQuestionSummary(value: string, maxLength = 240): string {
  const summary = value.replace(/\s+/g, ' ').trim();
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatQuestionTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function emptyWatchState(): OperatorWatchState {
  return {
    version: WATCH_STATE_VERSION,
    watches: {},
    cursors: {},
    messageListeners: {},
    messageCursors: {},
    idleCandidateFingerprints: {},
    pendingReports: [],
  };
}

function watchStateSessionIds(state: OperatorWatchState): Set<string> {
  return new Set([
    ...Object.keys(state.watches),
    ...Object.keys(state.cursors),
    ...Object.keys(state.messageListeners),
    ...Object.keys(state.messageCursors),
    ...Object.keys(state.idleCandidateFingerprints),
    ...state.pendingReports.map((report) => report.conductorAgentId),
  ]);
}

function extractWatchStateForSession(
  state: OperatorWatchState,
  conductorAgentId: string,
): OperatorWatchState {
  return {
    version: WATCH_STATE_VERSION,
    watches: state.watches[conductorAgentId]
      ? { [conductorAgentId]: state.watches[conductorAgentId]! }
      : {},
    cursors: state.cursors[conductorAgentId]
      ? { [conductorAgentId]: state.cursors[conductorAgentId]! }
      : {},
    messageListeners: state.messageListeners[conductorAgentId]
      ? { [conductorAgentId]: state.messageListeners[conductorAgentId]! }
      : {},
    messageCursors: state.messageCursors[conductorAgentId] !== undefined
      ? { [conductorAgentId]: state.messageCursors[conductorAgentId]! }
      : {},
    idleCandidateFingerprints:
      state.idleCandidateFingerprints[conductorAgentId]
        ? {
            [conductorAgentId]:
              state.idleCandidateFingerprints[conductorAgentId]!,
          }
        : {},
    pendingReports: state.pendingReports.filter(
      (report) => report.conductorAgentId === conductorAgentId,
    ),
  };
}

function removeWatchStateForSession(
  state: OperatorWatchState,
  conductorAgentId: string,
): void {
  delete state.watches[conductorAgentId];
  delete state.cursors[conductorAgentId];
  delete state.messageListeners[conductorAgentId];
  delete state.messageCursors[conductorAgentId];
  delete state.idleCandidateFingerprints[conductorAgentId];
  state.pendingReports = state.pendingReports.filter(
    (report) => report.conductorAgentId !== conductorAgentId,
  );
}

function summarizeWatchStateBundles(
  conductorAgentId: string,
  bundles: readonly OperatorWatchState[],
): string {
  const count = (select: (state: OperatorWatchState) => boolean) =>
    bundles.filter(select).length;
  const pendingReportCount = bundles.reduce(
    (total, bundle) =>
      total +
      bundle.pendingReports.filter(
        (report) => report.conductorAgentId === conductorAgentId,
      ).length,
    0,
  );
  return [
    `watches=${count((bundle) => conductorAgentId in bundle.watches)}`,
    `cursors=${count((bundle) => conductorAgentId in bundle.cursors)}`,
    `listeners=${count((bundle) => conductorAgentId in bundle.messageListeners)}`,
    `messageCursors=${count((bundle) => conductorAgentId in bundle.messageCursors)}`,
    `pendingReports=${pendingReportCount}`,
  ].join(', ');
}

function mergeWatchStates(
  preferred: OperatorWatchState,
  fallback: OperatorWatchState,
): OperatorWatchState {
  const merged = emptyWatchState();
  for (const field of [
    'watches',
    'cursors',
    'messageListeners',
    'messageCursors',
    'idleCandidateFingerprints',
  ] as const) {
    Object.assign(merged[field], fallback[field], preferred[field]);
  }
  const reportsById = new Map(
    fallback.pendingReports.map((report) => [report.reportId, report]),
  );
  for (const report of preferred.pendingReports) {
    reportsById.set(report.reportId, report);
  }
  merged.pendingReports = [...reportsById.values()];
  return merged;
}

function partitionWatchState(
  state: OperatorWatchState,
  pathById: ReadonlyMap<string, string>,
  issueUrlById: ReadonlyMap<string, string>,
): Map<string, OperatorWatchState> {
  const partitions = new Map<string, OperatorWatchState>();
  const getPartition = (path: string) => {
    let partition = partitions.get(path);
    if (!partition) {
      partition = emptyWatchState();
      partitions.set(path, partition);
    }
    return partition;
  };
  for (const field of [
    'watches',
    'cursors',
    'messageListeners',
    'messageCursors',
    'idleCandidateFingerprints',
  ] as const) {
    for (const [id, value] of Object.entries(state[field])) {
      const path = pathById.get(id);
      if (!path) {
        throw new Error(
          `Verified watch state for ${id} lost its Issue session mapping before persistence.`,
        );
      }
      (getPartition(path)[field] as Record<string, unknown>)[id] = value;
    }
  }
  for (const report of state.pendingReports) {
    const expectedIssueUrl = issueUrlById.get(report.conductorAgentId);
    const path = pathById.get(report.conductorAgentId);
    if (
      !path ||
      !expectedIssueUrl ||
      issueIdentity(expectedIssueUrl) !== issueIdentity(report.issueUrl)
    ) {
      throw new Error(
        `Verified pending watch report ${report.reportId} no longer matches its Issue session before persistence.`,
      );
    }
    getPartition(path).pendingReports.push(report);
  }
  return partitions;
}

function issueIdentity(issueUrl: string): string | undefined {
  try {
    const issue = parseIssueUrl(issueUrl);
    return `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`;
  } catch {
    return undefined;
  }
}

function repositoryForIssue(issueUrl: string): string | undefined {
  try {
    const issue = parseIssueUrl(issueUrl);
    return `${issue.owner}/${issue.repo}`.toLowerCase();
  } catch {
    return undefined;
  }
}

async function findSession(
  conductorAgentId: string,
  options: {
    root: string;
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  },
): Promise<LocatedSessionResumeStore | undefined> {
  return findUserSessionResumeStore(conductorAgentId, {
    userEnsembleRoot: options.root,
    onDuplicate: options.onDuplicate,
  });
}

function isAmbiguousResumeStoreError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('is ambiguous across saved Issues')
  );
}

async function loadWatchState(path: string): Promise<OperatorWatchState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || value.version !== WATCH_STATE_VERSION) {
      throw new Error('Invalid operator-agent watch state.');
    }
    const watches: Record<string, WatchConfig> = {};
    if (!isRecord(value.watches)) {
      throw new Error('Invalid operator-agent watch state: watches.');
    }
    for (const [id, rawWatch] of Object.entries(value.watches)) {
      if (
        !isRecord(rawWatch) ||
        rawWatch.conductorAgentId !== id ||
        typeof rawWatch.pollIntervalMs !== 'number' ||
        typeof rawWatch.debounceMs !== 'number'
      ) {
        throw new Error(`Invalid operator-agent watch state: watch ${id}.`);
      }
      watches[id] = {
        conductorAgentId: id,
        pollIntervalMs: parseBoundedInteger(
          rawWatch.pollIntervalMs,
          DEFAULT_POLL_INTERVAL_MS,
          MIN_POLL_INTERVAL_MS,
          MAX_POLL_INTERVAL_MS,
          'pollIntervalMs',
        ),
        debounceMs: parseBoundedInteger(
          rawWatch.debounceMs,
          250,
          0,
          MAX_DEBOUNCE_MS,
          'debounceMs',
        ),
      };
    }
    if (!isRecord(value.cursors)) {
      throw new Error('Invalid operator-agent watch state: cursors.');
    }
    const cursors: Record<string, SessionCursor> = {};
    for (const [id, rawCursor] of Object.entries(value.cursors)) {
      if (
        !isRecord(rawCursor) ||
        !Number.isSafeInteger(rawCursor.sequence) ||
        (rawCursor.sequence as number) < 0 ||
        !isStringRecord(rawCursor.questionFingerprints) ||
        !isStringRecord(rawCursor.statusFingerprints)
      ) {
        throw new Error(`Invalid operator-agent watch state: cursor ${id}.`);
      }
      let questionSnapshots: SessionCursor['questionSnapshots'];
      if (rawCursor.questionSnapshots !== undefined) {
        if (!isRecord(rawCursor.questionSnapshots)) {
          throw new Error(
            `Invalid operator-agent watch state: question snapshots ${id}.`,
          );
        }
        questionSnapshots = {};
        for (const [questionId, rawQuestion] of Object.entries(
          rawCursor.questionSnapshots,
        )) {
          if (
            !isRecord(rawQuestion) ||
            typeof rawQuestion.question !== 'string' ||
            (rawQuestion.status !== 'open' &&
              rawQuestion.status !== 'answered') ||
            typeof rawQuestion.askedAt !== 'number' ||
            !Number.isFinite(rawQuestion.askedAt)
          ) {
            throw new Error(
              `Invalid operator-agent watch state: question snapshot ${id}/${questionId}.`,
            );
          }
          questionSnapshots[questionId] = {
            question: rawQuestion.question,
            status: rawQuestion.status,
            askedAt: rawQuestion.askedAt,
          };
        }
      }
      let questionCountObservation: SessionCursor['questionCountObservation'];
      if (rawCursor.questionCountObservation !== undefined) {
        if (!isRecord(rawCursor.questionCountObservation)) {
          throw new Error(
            `Invalid operator-agent watch state: question count observation ${id}.`,
          );
        }
        // Older observations counted answered questions too. Drop those
        // values so a restart establishes a correct unanswered-count baseline.
        if (
          rawCursor.questionCountObservation.metric ===
          'unanswered_open_questions'
        ) {
          const parseCountSample = (
            sample: unknown,
          ): NonNullable<
            SessionCursor['questionCountObservation']
          >['current'] => {
            if (
              !isRecord(sample) ||
              !Number.isSafeInteger(sample.count) ||
              (sample.count as number) < 0 ||
              !Number.isSafeInteger(sample.checkedAt) ||
              (sample.checkedAt as number) < 0 ||
              (sample.source !== 'uds' && sample.source !== 'resume_store')
            ) {
              throw new Error(
                `Invalid operator-agent watch state: question count sample ${id}.`,
              );
            }
            return {
              count: sample.count as number,
              checkedAt: sample.checkedAt as number,
              source: sample.source,
            };
          };
          questionCountObservation = {
            metric: 'unanswered_open_questions',
            current: parseCountSample(
              rawCursor.questionCountObservation.current,
            ),
            ...(rawCursor.questionCountObservation.previous === undefined
              ? {}
              : {
                  previous: parseCountSample(
                    rawCursor.questionCountObservation.previous,
                  ),
                }),
          };
        }
      }
      cursors[id] = {
        sequence: rawCursor.sequence as number,
        questionFingerprints: rawCursor.questionFingerprints,
        ...(questionSnapshots ? { questionSnapshots } : {}),
        statusFingerprints: rawCursor.statusFingerprints,
        ...(questionCountObservation
          ? { questionCountObservation }
          : {}),
      };
    }
    const rawListeners = value.messageListeners ?? {};
    if (!isRecord(rawListeners)) {
      throw new Error('Invalid operator-agent watch state: messageListeners.');
    }
    const messageListeners: Record<string, ConductorMessageListenConfig> = {};
    for (const [id, rawListener] of Object.entries(rawListeners)) {
      if (
        !isRecord(rawListener) ||
        rawListener.conductorAgentId !== id ||
        typeof rawListener.messageDebounceMs !== 'number'
      ) {
        throw new Error(
          `Invalid operator-agent watch state: message listener ${id}.`,
        );
      }
      messageListeners[id] = {
        conductorAgentId: id,
        messageDebounceMs: parseBoundedInteger(
          rawListener.messageDebounceMs,
          DEFAULT_MESSAGE_DEBOUNCE_MS,
          0,
          MAX_MESSAGE_DEBOUNCE_MS,
          'messageDebounceMs',
        ),
      };
    }
    const rawMessageCursors = value.messageCursors ?? {};
    if (!isRecord(rawMessageCursors)) {
      throw new Error('Invalid operator-agent watch state: messageCursors.');
    }
    const messageCursors: Record<string, number> = {};
    for (const [id, cursor] of Object.entries(rawMessageCursors)) {
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) {
        throw new Error(
          `Invalid operator-agent watch state: message cursor ${id}.`,
        );
      }
      messageCursors[id] = cursor as number;
    }
    const rawIdleCandidateFingerprints =
      value.idleCandidateFingerprints ?? {};
    if (!isRecord(rawIdleCandidateFingerprints)) {
      throw new Error(
        'Invalid operator-agent watch state: idleCandidateFingerprints.',
      );
    }
    const idleCandidateFingerprints: OperatorWatchState['idleCandidateFingerprints'] =
      {};
    for (const [id, rawFingerprints] of Object.entries(
      rawIdleCandidateFingerprints,
    )) {
      if (!isRecord(rawFingerprints)) {
        throw new Error(
          `Invalid operator-agent watch state: idle candidate fingerprints ${id}.`,
        );
      }
      const fingerprints: OperatorWatchState['idleCandidateFingerprints'][string] =
        {};
      for (const [kind, fingerprint] of Object.entries(rawFingerprints)) {
        if (
          (kind !== 'idle_phase' && kind !== 'stale_running') ||
          typeof fingerprint !== 'string' ||
          fingerprint.trim().length === 0
        ) {
          throw new Error(
            `Invalid operator-agent watch state: idle candidate fingerprint ${id}/${kind}.`,
          );
        }
        fingerprints[kind] = fingerprint;
      }
      idleCandidateFingerprints[id] = fingerprints;
    }
    const pendingReports = value.pendingReports;
    if (!Array.isArray(pendingReports)) {
      throw new Error('Invalid operator-agent watch state: pendingReports.');
    }
    const reportIds = new Set<string>();
    for (const report of pendingReports) {
      if (
        !isRecord(report) ||
        typeof report.reportId !== 'string' ||
        report.reportId.trim().length === 0 ||
        typeof report.conductorAgentId !== 'string' ||
        typeof report.issueUrl !== 'string' ||
        typeof report.text !== 'string' ||
        (report.reportType !== 'session_state' &&
          report.reportType !== 'open_question' &&
          report.reportType !== 'conductor_message' &&
          report.reportType !== 'idle_candidate') ||
        typeof report.debounceMs !== 'number'
      ) {
        throw new Error('Invalid operator-agent watch state: pending report.');
      }
      if (
        report.reportType === 'conductor_message' &&
        (!Number.isSafeInteger(report.sendCount) ||
          (report.sendCount as number) < 0)
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending conductor message report.',
        );
      }
      if (
        report.oversizedSendCounts !== undefined &&
        (report.reportType !== 'conductor_message' ||
          !Array.isArray(report.oversizedSendCounts) ||
          report.oversizedSendCounts.length === 0 ||
          report.oversizedSendCounts.some(
            (sendCount) =>
              !Number.isSafeInteger(sendCount) ||
              (sendCount as number) < 0,
          ))
      ) {
        throw new Error(
          'Invalid operator-agent watch state: oversized conductor message report.',
        );
      }
      if (reportIds.has(report.reportId)) {
        throw new Error(
          'Invalid operator-agent watch state: duplicate pending reportId.',
        );
      }
      reportIds.add(report.reportId);
      if (
        !Number.isInteger(report.debounceMs) ||
        report.debounceMs < 0 ||
        report.debounceMs >
          (report.reportType === 'conductor_message'
            ? MAX_MESSAGE_DEBOUNCE_MS
            : MAX_DEBOUNCE_MS)
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report debounceMs.',
        );
      }
      if (
        report.readyAt !== undefined &&
        (typeof report.readyAt !== 'number' ||
          !Number.isSafeInteger(report.readyAt) ||
          report.readyAt < 0)
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report readyAt.',
        );
      }
      for (const field of [
        'arrivalOrder',
        'firstQueuedAt',
        'eligibleAt',
        'batchReadyAt',
        'retryReadyAt',
      ] as const) {
        const timestamp = report[field];
        if (
          timestamp !== undefined &&
          (typeof timestamp !== 'number' ||
            !Number.isSafeInteger(timestamp) ||
            timestamp < 0)
        ) {
          throw new Error(
            `Invalid operator-agent watch state: pending report ${field}.`,
          );
        }
      }
      if (
        report.priority !== undefined &&
          report.priority !== 'normal' &&
          report.priority !== 'open_question' &&
          report.priority !== 'idle'
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report priority.',
        );
      }
      if (
        (report.frozenBatchId !== undefined &&
          (typeof report.frozenBatchId !== 'string' ||
            report.frozenBatchId.trim().length === 0)) ||
        (report.frozenPayload !== undefined &&
          typeof report.frozenPayload !== 'string')
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report frozen batch.',
        );
      }
    }
    const normalizedPendingReports = pendingReports.map((report, index) => {
      const record = report as Record<string, unknown>;
      const readyAt =
        typeof record.readyAt === 'number' ? record.readyAt : 0;
      return {
        ...record,
        // Legacy v1 state had no persisted deadline and was replayed
        // immediately on startup.
        readyAt,
        // Old records have no queue-order metadata. Preserve their file order;
        // subsequent reports use the profile-wide locked sequence.
        arrivalOrder:
          typeof record.arrivalOrder === 'number'
            ? record.arrivalOrder
            : index,
        // Old queuedAt values are intentionally ignored. readyAt is the only
        // durable deadline they carried; new records retain firstQueuedAt.
        firstQueuedAt:
          typeof record.firstQueuedAt === 'number'
            ? record.firstQueuedAt
            : readyAt,
        priority:
          record.priority === 'idle' ||
          record.reportType === 'idle_candidate'
            ? 'idle'
            : record.priority === 'open_question' ||
                record.reportType === 'open_question'
              ? 'open_question'
            : 'normal',
      };
    }) as OperatorWatchState['pendingReports'];
    return {
      version: WATCH_STATE_VERSION,
      watches,
      cursors,
      messageListeners,
      messageCursors,
      idleCandidateFingerprints,
      pendingReports: normalizedPendingReports,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        version: WATCH_STATE_VERSION,
        watches: {},
        cursors: {},
        messageListeners: {},
        messageCursors: {},
        idleCandidateFingerprints: {},
        pendingReports: [],
      };
    }
    throw error;
  }
}

function saveWatchStateSync(path: string, state: OperatorWatchState): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

async function saveWatchState(
  path: string,
  state: OperatorWatchState,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function withWatchStateLock<T>(
  root: string,
  profile: string,
  operation: (nextArrivalOrder: (minimumExisting?: number) => number) => Promise<T>,
): Promise<T> {
  const workspace = join(root, 'operator-agents', profile);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const canonicalWorkspace = await realpath(workspace);
  return withOperatorWorkspaceLock(canonicalWorkspace, () =>
    withWatchStateLockInsideWorkspace(root, profile, operation),
  );
}

async function withWatchStateLockInsideWorkspace<T>(
  root: string,
  profile: string,
  operation: (nextArrivalOrder: (minimumExisting?: number) => number) => Promise<T>,
): Promise<T> {
  const directory = join(root, 'operator-agents', profile, 'watch');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const canonicalDirectory = await realpath(directory);
  const database = new DatabaseSync(
    join(canonicalDirectory, 'watch-state-lock.sqlite'),
  );
  let transactionStarted = false;
  let operationSucceeded = false;
  let operationError: unknown;
  try {
    await chmod(
      join(canonicalDirectory, 'watch-state-lock.sqlite'),
      0o600,
    );
    database.exec('PRAGMA busy_timeout = 0');
    let lastLockError: unknown;
    for (let attempt = 0; attempt < WATCH_STATE_LOCK_RETRIES; attempt += 1) {
      try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        break;
      } catch (error) {
        if (!isSqliteLockContention(error)) throw error;
        lastLockError = error;
        if (attempt + 1 < WATCH_STATE_LOCK_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, WATCH_STATE_LOCK_RETRY_DELAY_MS),
          );
        }
      }
    }
    if (!transactionStarted) {
      throw new Error(
        `Could not acquire operator watch state profile lock after ${WATCH_STATE_LOCK_RETRIES} attempts.`,
        { cause: lastLockError },
      );
    }
    database.exec(
      'CREATE TABLE IF NOT EXISTS operator_watch_order (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)',
    );
    database
      .prepare(
        'INSERT INTO operator_watch_order (id, value) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(Date.now() * 1_000);
    const nextArrivalOrder = (minimumExisting = 0) => {
      const row = database
        .prepare('SELECT value FROM operator_watch_order WHERE id = 1')
        .get() as { value: number } | undefined;
      if (!row || !Number.isSafeInteger(row.value)) {
        throw new Error('Operator watch order counter is missing or invalid.');
      }
      const next = Math.max(
        row.value + 1,
        minimumExisting + 1,
        Date.now() * 1_000,
      );
      if (!Number.isSafeInteger(next)) {
        throw new Error('Operator watch order counter exceeded safe integer range.');
      }
      database
        .prepare('UPDATE operator_watch_order SET value = ? WHERE id = 1')
        .run(next);
      return next;
    };
    const result = await operation(nextArrivalOrder);
    operationSucceeded = true;
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseError: unknown;
    try {
      if (transactionStarted) {
        database.exec(operationSucceeded ? 'COMMIT' : 'ROLLBACK');
      }
    } catch (error) {
      releaseError = error;
    }
    try {
      database.close();
    } catch (error) {
      releaseError =
        releaseError === undefined
          ? error
          : new AggregateError([releaseError, error]);
    }
    if (releaseError !== undefined) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          'Operator watch state update failed and its profile lock could not be released.',
        );
      }
      throw releaseError;
    }
  }
}

function isSqliteLockContention(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('errcode' in error) ||
    typeof error.errcode !== 'number'
  ) {
    return false;
  }
  const primaryCode = error.errcode & 0xff;
  return primaryCode === 5 || primaryCode === 6;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toolResult(value: ConductorJsonValue): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : { value },
  };
}

function parseBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalNumber(
  value: ConductorJsonValue | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`${name} must be an integer.`);
  return value;
}

function requireToolString(
  value: ConductorJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return requireNonEmptyString(value, name);
}

function requireNonEmptyString(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} must not be empty.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function formatResumeStoreDuplicateDiagnostic(
  diagnostic: SessionResumeStoreDuplicateDiagnostic,
): string {
  const candidates = diagnostic.candidates
    .map(
      (candidate) =>
        `${candidate.location}=${candidate.path} (harnessSocketPath=${candidate.hasHarnessSocketPath ? 'present' : 'absent'})`,
    )
    .join('; ');
  const selected = diagnostic.candidates.find(
    (candidate) => candidate.path === diagnostic.selectedPath,
  );
  return (
    `duplicate SessionResumeStore for ${diagnostic.conductorAgentId}; ` +
    `selected ${diagnostic.selectedLocation}=${diagnostic.selectedPath} ` +
    `(harnessSocketPath=${selected?.hasHarnessSocketPath ? 'present' : 'absent'}); ` +
    `candidates: ${candidates}`
  );
}

function formatWatchPollError(conductorAgentId: string, error: unknown): string {
  const errorType =
    error instanceof Error && error.name ? error.name : 'unknown error';
  return `Failed to poll watched session ${conductorAgentId} (${errorType}).`;
}

function formatConductorMessagePollError(
  conductorAgentId: string,
  error: unknown,
): string {
  const errorType =
    error instanceof Error && error.name ? error.name : 'unknown error';
  return `Failed to poll conductor messages for session ${conductorAgentId} (${errorType}).`;
}

function formatPendingReportRefreshError(error: unknown): string {
  const errorType =
    error instanceof Error && error.name ? error.name : 'unknown error';
  return `Failed to refresh persisted operator watch reports (${errorType}).`;
}
