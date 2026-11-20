import {
  readObservation,
  readConductorMessageBaseline,
  readConductorMessagePages,
  formatConductorMessageReport,
} from './operator-watch-observation.js';
export {
  createRegisterSessionWatchTool,
  createUnregisterSessionWatchTool,
  createRegisterRepositoryWatchTool,
  createUnregisterRepositoryWatchTool,
  createRegisterConductorMessageListenTool,
  createUnregisterConductorMessageListenTool,
} from './operator-watch-tools.js';
import { loadWatchState, saveWatchState, saveWatchStateSync, withWatchStateLock } from './watch-state-store.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_DEBOUNCE_MS,
  DEFAULT_MESSAGE_DEBOUNCE_MS,
  MAX_MESSAGE_DEBOUNCE_MS,
  parseBoundedInteger,
  requireNonEmptyString,
} from './operator-watch-validation.js';
import { hash } from './operator-watch-hash.js';
import { createSchedulingEventWriter } from './operator-scheduling-events.js';
import { collectReports, cursorFor } from './operator-watch-reports.js';
import {
  emptyWatchState,
  watchStateSessionIds,
  extractWatchStateForSession,
  removeWatchStateForSession,
  summarizeWatchStateBundles,
  mergeWatchStates,
  partitionWatchState,
  issueIdentity,
  type OperatorWatchState,
} from './operator-watch-state.js';
import { isEnoent } from './operator-utils.js';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findUserSessionResumeStore,
  listUserLocatedSessionResumeStoresPage,
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlTransportError,
  parseIssueUrl,
  resolveUserEnsembleRoot,
  sendOpenQuestionControlRequest,
  type SessionObservationSnapshot,
  type SessionResumeStoreDuplicateDiagnostic,
  type LocatedSessionResumeStore,
} from '@agents-ensemble/core/operator-runtime';
import {
  listOperatorWatchStatePaths,
  operatorWatchStatePath,
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
} from './operator-dispatch.js';
import { formatOversizedConductorMessageWarning } from './operator-dispatch.js';

import type {
  ConductorMessageListenConfig,
  CreateOperatorWatchPoolOptions,
  OperatorIdleCandidateObservation,
  OperatorSessionLiveStatus,
  OperatorSessionTrackingInfo,
  OperatorWatchPool,
  WatchConfig,
} from './types.js';

const MESSAGE_POLL_INTERVAL_MS = 2_000;
const PENDING_REPORT_REFRESH_INTERVAL_MS = 2_000;

export type {
  ConductorMessageListenConfig,
  CreateOperatorWatchPoolOptions,
  OperatorIdleCandidateObservation,
  OperatorSessionLiveStatus,
  OperatorSessionTrackingInfo,
  OperatorWatchPool,
} from './types.js';

export { operatorWatchStatePath } from './operator-state-paths.js';

export async function createOperatorWatchPool(
  options: CreateOperatorWatchPoolOptions,
): Promise<OperatorWatchPool> {
  const root = options.userEnsembleRoot ?? resolveUserEnsembleRoot();
  const profile = options.profile ?? 'default';
  await listOperatorWatchStatePaths(root, profile);
  const eventWriter = createSchedulingEventWriter(root, profile, options.onError);
  const schedulingInstanceId = randomUUID();
  const recordQueued = (report: {
    reportId: string;
    reportType: string;
    priority?: string;
    conductorAgentId: string;
    firstQueuedAt?: number;
    readyAt: number;
  }, evidence?: { phase: 'idle' | 'running'; ageMs: number; thresholdMs: number }) => eventWriter.record({
    type: 'report.queued', ts: Date.now(), reportId: report.reportId,
    reportType: report.reportType, priority: report.priority,
    conductorAgentId: report.conductorAgentId,
    firstQueuedAt: report.firstQueuedAt, readyAt: report.readyAt,
    ...(evidence ? { evidence } : {}),
  });
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
      const targetPath = operatorWatchStatePath(root, profile, issueUrl);
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
      targetPath = operatorWatchStatePath(
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
          for (const report of reports) recordQueued(report);
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
          for (const report of reports) recordQueued(report);
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
    recordSchedulingEvent: (event) => eventWriter.record({ ...event, schedulingInstanceId }),
    flushSchedulingEvents: () => eventWriter.flush(),
    async acknowledge(events) {
      const acknowledged = new Set(
        events.flatMap((event) =>
          event.type === 'report' && event.reportId ? [event.reportId] : [],
        ),
      );
      if (acknowledged.size === 0) return;
      await withStateLock(async () => {
        const removed = state.pendingReports.filter(
          (report) => acknowledged.has(report.reportId),
        );
        const remaining = state.pendingReports.filter(
          (report) => !acknowledged.has(report.reportId),
        );
        if (remaining.length === state.pendingReports.length) return;
        state.pendingReports = remaining;
        await persist();
        const ackedAt = Date.now();
        for (const report of removed) {
          eventWriter.record({
            type: 'report.acked', ts: ackedAt, reportId: report.reportId,
            firstQueuedAt: report.firstQueuedAt, ackedAt,
          });
        }
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
        recordQueued(state.pendingReports.find((report) => report.reportId === reportId)!, input.evidence);
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
            eventWriter.record({
              type: 'batch.committed', ts: Date.now(), batchId: batch.batchId,
              sourceKey: batch.sourceKey,
              reportIds: reports.map((event) => event.reportId),
              count: reports.length,
              reportTypes: reports.map((event) => event.reportType),
              oldestFirstQueuedAt: Math.min(...reports.map((event) => event.firstQueuedAt ?? event.readyAt)),
              readyReason: batch.selectionReason === 'oq' || batch.selectionReason === 'continuation' || batch.selectionReason === 'aged_idle'
                ? batch.selectionReason : batch.deadlineReason === 'cap' || batch.deadlineReason === 'quiet' ? batch.deadlineReason : 'unknown',
              deadlineReason: batch.deadlineReason ?? 'unknown',
              eligibility: batch.eligibility ?? 'unknown',
              selectionReason: batch.selectionReason ?? 'unknown',
              usedContinuation: batch.usedContinuation,
            });
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
      eventWriter.close();
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
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

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
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
