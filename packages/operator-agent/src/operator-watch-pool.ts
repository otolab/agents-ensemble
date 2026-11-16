import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
import type {
  OperatorDispatchEvent,
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
}

export interface ConductorMessageListenConfig {
  conductorAgentId: string;
  messageDebounceMs: number;
}

export interface OperatorSessionLiveStatus {
  connectivity: 'reachable' | 'unreachable' | 'unknown';
  checkedAt: number | null;
  unreachableSince: number | null;
}

interface OperatorWatchState {
  version: typeof WATCH_STATE_VERSION;
  watches: Record<string, WatchConfig>;
  cursors: Record<string, SessionCursor>;
  messageListeners: Record<string, ConductorMessageListenConfig>;
  messageCursors: Record<string, number>;
  pendingReports: Array<{
    reportId: string;
    reportType: 'session_state' | 'open_question' | 'conductor_message';
    conductorAgentId: string;
    issueUrl: string;
    text: string;
    debounceMs: number;
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
  registerConductorMessageListen(
    conductorAgentId: string,
    options?: { messageDebounceMs?: number },
  ): Promise<ConductorMessageListenConfig>;
  unregisterConductorMessageListen(conductorAgentId: string): Promise<boolean>;
  listConductorMessageListens(): ConductorMessageListenConfig[];
  pollOnce(conductorAgentId: string): Promise<number>;
  pollConductorMessagesOnce(conductorAgentId: string): Promise<number>;
  getLiveStatus(conductorAgentId: string): OperatorSessionLiveStatus | undefined;
  acknowledge(events: readonly OperatorDispatchEvent[]): Promise<void>;
  close(): void;
}

export interface CreateOperatorWatchPoolOptions {
  /** User storage root used by the operator-agent runtime. */
  userEnsembleRoot?: string;
  /** Profile whose watch state is active. */
  profile?: string;
  /** @deprecated Test and internal compatibility for pre-Phase 3 callers. */
  repoRoot?: string;
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
  const refreshStateFromDisk = async () => {
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
  };
  await withWatchStateLock(root, profile, refreshStateFromDisk);
  const timers = new Map<string, NodeJS.Timeout>();
  const polling = new Set<string>();
  const messageTimers = new Map<string, NodeJS.Timeout>();
  const messagePolling = new Set<string>();
  const liveStatuses = new Map<string, OperatorSessionLiveStatus>();
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
  const withStateLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = stateOperationQueue.then(() =>
      withWatchStateLock(root, profile, async () => {
        await refreshStateFromDisk();
        return operation();
      }),
    );
    stateOperationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
      for (const report of promoted.pendingReports) {
        options.dispatchQueue.enqueueReports(
          [{
            type: 'report',
            reportId: report.reportId,
            reportType: report.reportType,
            conductorAgentId: report.conductorAgentId,
            issueUrl: report.issueUrl,
            text: report.text,
            sendCount: report.sendCount,
            oversizedSendCounts: report.oversizedSendCounts,
          }],
          0,
        );
      }
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
        state.watches[id] = nextWatch;
        try {
          await persist();
        } catch (error) {
          if (previousWatch) state.watches[id] = previousWatch;
          else delete state.watches[id];
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
        try {
          await persist();
        } catch (error) {
          state.watches[id] = previousWatch;
          throw error;
        }
        return true;
      });
      if (!removed) return false;
      const timer = timers.get(id);
      if (timer) clearInterval(timer);
      timers.delete(id);
      return true;
    },
    list() {
      return Object.values(state.watches).map((watch) => ({ ...watch }));
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
        try {
          await persist();
        } catch (error) {
          if (previous) state.messageListeners[id] = previous;
          else delete state.messageListeners[id];
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
      if (Date.now() - status.checkedAt > 10_000) return undefined;
      return { ...status };
    },
    async pollOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      if (closed || polling.has(id)) return 0;
      polling.add(id);
      try {
        return await withStateLock(async () => {
          const watch = state.watches[id];
          if (!watch || closed) return 0;
          let located: LocatedSessionResumeStore | undefined;
          try {
            located = await locateSession(id);
          } catch (error) {
            if (isAmbiguousResumeStoreError(error)) return 0;
            throw error;
          }
          if (!located) return 0;
          const binding = bindLocatedSession(id, located);
          if (!binding.assigned) return 0;
          const {
            snapshot: observation,
            source,
            connectivity,
          } = await readObservation(root, located);
          const resumeStore = located.resumeStore;
          const previousLiveStatus = liveStatuses.get(id);
          const checkedAt = Date.now();
          liveStatuses.set(id, {
            connectivity,
            checkedAt: connectivity === 'unknown' ? null : checkedAt,
            unreachableSince:
              connectivity === 'unreachable'
                ? previousLiveStatus?.connectivity === 'unreachable'
                  ? previousLiveStatus.unreachableSince ?? checkedAt
                  : checkedAt
                : null,
          });
          const previous = state.cursors[id];
          const next = cursorFor(observation);
          const debounceMs = Math.max(
            watch.debounceMs,
            state.messageListeners[id]?.messageDebounceMs ?? 0,
          );
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
          }));
          const cursorChanged = hash(previous ?? null) !== hash(next);
          if (reports.length > 0) state.pendingReports.push(...reports);
          state.cursors[id] = next;
          if (reports.length > 0 || cursorChanged) await persist();
          options.dispatchQueue.enqueueReports(
            reports.map((report) => ({
              type: 'report',
              reportId: report.reportId,
              reportType: report.reportType,
              conductorAgentId: id,
              issueUrl: resumeStore.issueUrl,
              text: report.text,
            })),
            debounceMs,
          );
          return reports.length;
        });
      } finally {
        polling.delete(id);
      }
    },
    async pollConductorMessagesOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      if (closed || messagePolling.has(id)) return 0;
      messagePolling.add(id);
      try {
        return await withStateLock(async () => {
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
              sendCount: oversizedSendCounts.at(-1)!,
              oversizedSendCounts,
            });
          }
          reports.sort(
            (left, right) =>
              (left.sendCount ?? 0) - (right.sendCount ?? 0),
          );
          state.messageCursors[id] = nextCursor;
          if (reports.length > 0) state.pendingReports.push(...reports);
          if (reports.length > 0 || nextCursor !== cursor) await persist();
          options.dispatchQueue.enqueueDebouncedReports(
            reports.map((report) => ({
              type: 'report',
              reportId: report.reportId,
              reportType: 'conductor_message',
              conductorAgentId: id,
              issueUrl: resumeStore.issueUrl,
              text: report.text,
              sendCount: report.sendCount,
              oversizedSendCounts: report.oversizedSendCounts,
            })),
            listener.messageDebounceMs,
          );
          if (readResult.responseSizeError) {
            throw readResult.responseSizeError;
          }
          return reports.length;
        });
      } finally {
        messagePolling.delete(id);
      }
    },
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
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      for (const timer of messageTimers.values()) clearInterval(timer);
      messageTimers.clear();
    },
  };

  for (const report of state.pendingReports) {
    options.dispatchQueue.enqueueReports(
      [{
        type: 'report',
        reportId: report.reportId,
        reportType: report.reportType,
        conductorAgentId: report.conductorAgentId,
        issueUrl: report.issueUrl,
        text: report.text,
        sendCount: report.sendCount,
        oversizedSendCounts: report.oversizedSendCounts,
      }],
      0,
    );
  }
  for (const watch of pool.list()) startTimer(watch);
  for (const listener of pool.listConductorMessageListens()) {
    startMessageTimer(listener);
  }
  return pool;
}

export function createRegisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_session_watch',
    description:
      'Add a saved Issue session to the operator watch pool. Reports new open questions, open-to-answered transitions, and disappearance from the observed question list. Each report identifies whether it came from live harness UDS or saved SessionResumeStore/YAML.',
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
    description: 'Remove an Issue session from the operator watch pool.',
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
}> {
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
        error instanceof OpenQuestionControlTransportError
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

function cursorFor(observation: SessionObservationSnapshot): SessionCursor {
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
    pendingReports: [],
  };
}

function watchStateSessionIds(state: OperatorWatchState): Set<string> {
  return new Set([
    ...Object.keys(state.watches),
    ...Object.keys(state.cursors),
    ...Object.keys(state.messageListeners),
    ...Object.keys(state.messageCursors),
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
      cursors[id] = {
        sequence: rawCursor.sequence as number,
        questionFingerprints: rawCursor.questionFingerprints,
        ...(questionSnapshots ? { questionSnapshots } : {}),
        statusFingerprints: rawCursor.statusFingerprints,
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
          report.reportType !== 'conductor_message') ||
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
    }
    return {
      version: WATCH_STATE_VERSION,
      watches,
      cursors,
      messageListeners,
      messageCursors,
      pendingReports: pendingReports as OperatorWatchState['pendingReports'],
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        version: WATCH_STATE_VERSION,
        watches: {},
        cursors: {},
        messageListeners: {},
        messageCursors: {},
        pendingReports: [],
      };
    }
    throw error;
  }
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
  operation: () => Promise<T>,
): Promise<T> {
  const directory = join(root, 'operator-agents', profile, 'watch');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const canonicalDirectory = await realpath(directory);
  const database = new DatabaseSync(
    join(canonicalDirectory, 'watch-state-lock.sqlite'),
  );
  let transactionStarted = false;
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
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseError: unknown;
    try {
      if (transactionStarted) database.exec('ROLLBACK');
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
