import { randomUUID } from 'node:crypto';
import type { LocatedSessionResumeStore } from '@agents-ensemble/core/operator-runtime';
import {
  readObservation,
  readConductorMessageBaseline,
  readConductorMessagePages,
  formatConductorMessageReport,
} from './operator-watch-observation.js';
import { formatOversizedConductorMessageWarning } from './operator-dispatch.js';
import { collectReports, cursorFor } from './operator-watch-reports.js';
import { hash } from './operator-watch-hash.js';
import { issueIdentity, type OperatorWatchState } from './operator-watch-state.js';
import { requireNonEmptyString } from './operator-watch-validation.js';
import type { OperatorWatchPool, OperatorIdleCandidateObservation, OperatorSessionLiveStatus, WatchConfig } from './types.js';
import type { WatchIdentityContext } from './operator-watch-identity.js';

export interface WatchPollContext extends WatchIdentityContext {
  readonly closed: boolean;
  idleCandidateObservationVersion: number;
  readonly autoWatches: Map<string, WatchConfig>;
  readonly polling: Set<string>;
  readonly pollCompletions: Map<string, Promise<void>>;
  readonly messagePolling: Set<string>;
  readonly liveStatuses: Map<string, OperatorSessionLiveStatus>;
  readonly withStateLock: <T>(operation: (nextArrivalOrder: () => number) => Promise<T>, syncQueue?: boolean) => Promise<T>;
  readonly persist: () => Promise<void>;
  readonly retainReadyBatch: (id: string, now: number) => void;
  readonly recordQueued: (report: OperatorWatchState['pendingReports'][number]) => void;
}

type IdentityOperations = {
  locateSession: (id: string) => Promise<LocatedSessionResumeStore | undefined>;
  bindLocatedSession: (id: string, located: LocatedSessionResumeStore) => { assigned: boolean; reason?: string };
};

export function createWatchPollOperations(
  context: WatchPollContext,
  identity: IdentityOperations,
): Pick<OperatorWatchPool, 'refreshIdleCandidateObservation' | 'pollOnce' | 'pollConductorMessagesOnce'> {
  const {
    root, autoWatches, pathById, issueUrlById, idleCandidateObservations,
    polling, pollCompletions, messagePolling, liveStatuses, withStateLock,
    persist, retainReadyBatch, recordQueued, findSession, isAmbiguousResumeStoreError,
  } = context;
  const { locateSession, bindLocatedSession } = identity;
  return {
    async refreshIdleCandidateObservation(
      conductorAgentId,
      afterObservationVersion,
    ) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const watch = context.state.watches[id] ?? autoWatches.get(id);
      const assignedWatchStatePath = pathById.get(id);
      const assignedIssueUrl = issueUrlById.get(id);
      if (
        context.closed ||
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
          context.closed || !(context.state.watches[id] ?? autoWatches.get(id)) ||
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
        const currentWatch = context.state.watches[id] ?? autoWatches.get(id);
        if (
          context.closed ||
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
          observationVersion: ++context.idleCandidateObservationVersion,
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
      if (context.closed || polling.has(id)) return 0;
      polling.add(id);
      let resolvePollCompletion!: () => void;
      const pollCompletion = new Promise<void>((resolve) => {
        resolvePollCompletion = resolve;
      });
      pollCompletions.set(id, pollCompletion);
      try {
        return await withStateLock(async (nextArrivalOrder) => {
          const watch = context.state.watches[id] ?? autoWatches.get(id);
          if (!watch || context.closed) return 0;
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
              observationVersion: ++context.idleCandidateObservationVersion,
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
          const previous = context.state.cursors[id];
          const next = cursorFor(observation, checkedAt, source, previous);
          const debounceMs = Math.max(
            watch.debounceMs,
            context.state.messageListeners[id]?.messageDebounceMs ?? 0,
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
            context.state.pendingReports.push(...reports);
          }
          context.state.cursors[id] = next;
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
      if (context.closed || messagePolling.has(id)) return 0;
      messagePolling.add(id);
      try {
        return await withStateLock(async (nextArrivalOrder) => {
          const listener = context.state.messageListeners[id];
          if (!listener || context.closed) return 0;
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
          const cursor = context.state.messageCursors[id];
          if (cursor === undefined) {
            context.state.messageCursors[id] = await readConductorMessageBaseline(
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
          for (let index = 0; index < messageEvents.length;) {
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
          context.state.messageCursors[id] = nextCursor;
          if (reports.length > 0) {
            retainReadyBatch(id, queuedAt);
            for (const pending of context.state.pendingReports) {
              if (
                pending.conductorAgentId === id &&
                !pending.frozenBatchId
              ) pending.readyAt = readyAt;
            }
            context.state.pendingReports.push(...reports);
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
  };
}
