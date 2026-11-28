import {
  findUserSessionResumeStore,
  listUserLocatedSessionResumeStoresPage,
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlTransportError,
  parseIssueUrl,
  resolveUserEnsembleRoot,
  sendOpenQuestionControlRequest,
  type LocatedSessionResumeStore,
  type SessionObservationSnapshot,
  type SessionResumeStoreDuplicateDiagnostic,
} from '@agents-ensemble/core/operator-runtime';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import {
  DEFAULT_REPOSITORY_AUTO_POLL_INTERVAL_MS,
  DEFAULT_REPOSITORY_SCAN_INTERVAL_MS,
  emptyOperatorRepositoryWatchState,
  loadOperatorRepositoryWatchState,
  MAX_REPOSITORY_SCAN_INTERVAL_MS,
  MAX_REPOSITORY_WATCHES,
  MIN_REPOSITORY_SCAN_INTERVAL_MS,
  operatorRepositoryWatchStatePath,
  saveOperatorRepositoryWatchState,
  type RepositoryWatchConfig,
} from './operator-repository-watch-state.js';
import { createSchedulingEventWriter } from '../dispatch/operator-scheduling-events.js';
import {
  listOperatorWatchStatePaths,
  operatorWatchStatePath,
} from '../internal/operator-state-paths.js';
import { isEnoent } from '../internal/operator-utils.js';
import {
  createWatchDispatchOperations,
  type WatchDispatchContext,
} from './operator-watch-dispatch.js';
import { hash } from './operator-watch-hash.js';
import { createWatchIdentityOperations } from './operator-watch-identity.js';
import { readConductorMessageBaseline } from './operator-watch-observation.js';
import { createWatchPollOperations } from './operator-watch-poll.js';
import { createWatchRepositoryOperations } from './operator-watch-repository.js';
import {
  emptyWatchState,
  extractWatchStateForSession,
  issueIdentity,
  mergeWatchStates,
  partitionWatchState,
  summarizeWatchStateBundles,
  watchStateSessionIds,
  type OperatorWatchState,
} from './operator-watch-state.js';
import {
  DEFAULT_MESSAGE_DEBOUNCE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_DEBOUNCE_MS,
  MAX_MESSAGE_DEBOUNCE_MS,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  parseBoundedInteger,
  requireNonEmptyString,
} from './operator-watch-validation.js';
import { loadWatchState, saveWatchState, withWatchStateLock } from './watch-state-store.js';
export {
  createRegisterSessionWatchTool,
  createUnregisterSessionWatchTool,
  createRegisterRepositoryWatchTool,
  createUnregisterRepositoryWatchTool,
  createRegisterConductorMessageListenTool,
  createUnregisterConductorMessageListenTool,
} from './operator-watch-tools.js';

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

export { operatorWatchStatePath } from '../internal/operator-state-paths.js';

export async function createOperatorWatchPool(
  options: CreateOperatorWatchPoolOptions,
): Promise<OperatorWatchPool> {
  const root = options.userEnsembleRoot ?? resolveUserEnsembleRoot();
  const profile = options.profile ?? 'default';
  const configScope = options.configScope;
  await listOperatorWatchStatePaths(root, profile, configScope);
  const eventWriter = createSchedulingEventWriter(
    root,
    profile,
    options.onError,
    configScope,
  );
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
      const targetPath = operatorWatchStatePath(
        root,
        profile,
        issueUrl,
        configScope,
      );
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
  const repositoryStatePath = operatorRepositoryWatchStatePath(
    root,
    profile,
    configScope,
  );
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
      ...(await listOperatorWatchStatePaths(root, profile, configScope)),
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
  await withWatchStateLock(
    root,
    profile,
    () => refreshStateFromDisk(),
    configScope,
  );
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
      }, configScope),
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
  const watchContext: WatchDispatchContext = {
    root, profile, options, storesById, pathById, issueUrlById,
    loadedStatesByPath, statePaths, stateSourcesById, unassignedStateByPath,
    unassignedDiagnostics, ambiguousResumeStoreIds, idleCandidateObservations,
    timers, messageTimers, reportedResumeStoreDuplicates, reportUnassignedBundle,
    onResumeStoreDuplicate, findSession, isAmbiguousResumeStoreError,
    autoWatches, polling, pollCompletions, messagePolling, liveStatuses,
    withStateLock, persist, retainReadyBatch, recordQueued, eventWriter,
    get closed() { return closed; },
    get idleCandidateObservationVersion() { return idleCandidateObservationVersion; },
    set idleCandidateObservationVersion(value: number) { idleCandidateObservationVersion = value; },
    get state() { return state; },
    set state(value: OperatorWatchState) { state = value; },
    get repositoryState() { return repositoryState; },
  };
  const { locateSession, bindLocatedSession, verifyUniqueLocatedSession } = createWatchIdentityOperations(watchContext);
  const { assertRepositoryAllowed, repositoryIsInActiveScope, nextFirstObservedAt, listRepositoryStores, reconcileRepositoryAutoWatches } = createWatchRepositoryOperations(watchContext);
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
  const pollOperations = createWatchPollOperations(watchContext, { locateSession, bindLocatedSession });
  const dispatchOperations = createWatchDispatchOperations(watchContext);
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
    ...pollOperations,
    refreshPendingReports,
    recordSchedulingEvent: (event) => eventWriter.record({ ...event, schedulingInstanceId }),
    flushSchedulingEvents: () => eventWriter.flush(),
    ...dispatchOperations,
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
