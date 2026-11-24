import type { LocatedSessionResumeStore, SessionResumeStoreDuplicateDiagnostic } from '@agents-ensemble/core/operator-runtime';
import { operatorWatchStatePath } from '../internal/operator-state-paths.js';
import {
  emptyWatchState,
  extractWatchStateForSession,
  removeWatchStateForSession,
  mergeWatchStates,
  watchStateSessionIds,
  issueIdentity,
  type OperatorWatchState,
} from './operator-watch-state.js';
import type { OperatorIdleCandidateObservation } from './types.js';
import type { WatchRepositoryContext } from './operator-watch-repository.js';

export interface WatchIdentityContext extends WatchRepositoryContext {
  state: OperatorWatchState;
  readonly profile: string;
  readonly storesById: Map<string, LocatedSessionResumeStore[]>;
  readonly pathById: Map<string, string>;
  readonly issueUrlById: Map<string, string>;
  readonly loadedStatesByPath: Map<string, OperatorWatchState>;
  readonly statePaths: Set<string>;
  readonly stateSourcesById: Map<string, Set<string>>;
  readonly unassignedStateByPath: Map<string, OperatorWatchState>;
  readonly unassignedDiagnostics: Map<string, string>;
  readonly ambiguousResumeStoreIds: Set<string>;
  readonly idleCandidateObservations: Map<string, OperatorIdleCandidateObservation>;
  readonly timers: Map<string, NodeJS.Timeout>;
  readonly messageTimers: Map<string, NodeJS.Timeout>;
  readonly reportedResumeStoreDuplicates: Map<string, string>;
  readonly reportUnassignedBundle: (
    id: string, reason: string, sourcePaths: readonly string[],
    bundles: readonly OperatorWatchState[],
  ) => void;
  readonly findSession: (
    id: string,
    options: { root: string; onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void },
  ) => Promise<LocatedSessionResumeStore | undefined>;
  readonly isAmbiguousResumeStoreError: (error: unknown) => boolean;
}

export function createWatchIdentityOperations(context: WatchIdentityContext) {
  const {
    root, profile, options, storesById, pathById, issueUrlById,
    loadedStatesByPath, statePaths, stateSourcesById, unassignedStateByPath,
    unassignedDiagnostics, ambiguousResumeStoreIds, idleCandidateObservations,
    timers, messageTimers, reportedResumeStoreDuplicates, reportUnassignedBundle,
    onResumeStoreDuplicate, findSession, isAmbiguousResumeStoreError,
  } = context;
  const quarantineActiveSession = (
    id: string,
    reason: string,
  ): boolean => {
    const activeBundle = extractWatchStateForSession(context.state, id);
    if (watchStateSessionIds(activeBundle).size === 0) return false;
    const sourcePath = pathById.get(id);
    if (!sourcePath) return false;

    removeWatchStateForSession(context.state, id);
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
          : extractWatchStateForSession(context.state, id),
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
      context.state = mergeWatchStates(context.state, promoted);
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
  return { locateSession, bindLocatedSession, verifyUniqueLocatedSession };
}
