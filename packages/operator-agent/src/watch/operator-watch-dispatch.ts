import { randomUUID } from 'node:crypto';
import type { OperatorDispatchEvent } from '../dispatch/operator-dispatch.js';
import { mergeWatchStates, partitionWatchState, type OperatorWatchState } from './operator-watch-state.js';
import { saveWatchStateSync } from './watch-state-store.js';
import { requireNonEmptyString } from './operator-watch-validation.js';
import type { OperatorWatchPool } from './types.js';
import type { WatchPollContext } from './operator-watch-poll.js';
import type { createSchedulingEventWriter } from '../dispatch/operator-scheduling-events.js';

export interface WatchDispatchContext extends WatchPollContext {
  readonly eventWriter: ReturnType<typeof createSchedulingEventWriter>;
  readonly recordQueued: (
    report: OperatorWatchState['pendingReports'][number],
    evidence?: { phase: 'idle' | 'running'; ageMs: number; thresholdMs: number },
  ) => void;
}

export function createWatchDispatchOperations(
  context: WatchDispatchContext,
): Pick<OperatorWatchPool, 'acknowledge' | 'enqueueIdleCandidate' | 'commitBatch' | 'recordRetry'> {
  const {
    options, eventWriter, withStateLock, persist, retainReadyBatch, recordQueued,
    issueUrlById, pathById, statePaths, unassignedStateByPath,
  } = context;
  return {
    async acknowledge(events) {
      const acknowledged = new Set(
        events.flatMap((event) =>
          event.type === 'report' && event.reportId ? [event.reportId] : [],
        ),
      );
      if (acknowledged.size === 0) return;
      await withStateLock(async () => {
        const removed = context.state.pendingReports.filter(
          (report) => acknowledged.has(report.reportId),
        );
        const remaining = context.state.pendingReports.filter(
          (report) => !acknowledged.has(report.reportId),
        );
        if (remaining.length === context.state.pendingReports.length) return;
        context.state.pendingReports = remaining;
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
          (context.state.idleCandidateFingerprints[conductorAgentId] ??= {});
        if (fingerprints[input.kind] === fingerprint) return false;
        const queuedAt = Date.now();
        const previousFingerprint = fingerprints[input.kind];
        fingerprints[input.kind] = fingerprint;
        retainReadyBatch(conductorAgentId, queuedAt);
        context.state.pendingReports.push({
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
          context.state.pendingReports = context.state.pendingReports.filter(
            (report) => report.reportId !== reportId,
          );
          if (previousFingerprint === undefined) {
            delete fingerprints[input.kind];
            if (Object.keys(fingerprints).length === 0) {
              delete context.state.idleCandidateFingerprints[conductorAgentId];
            }
          } else {
            fingerprints[input.kind] = previousFingerprint;
          }
          throw error;
        }
        recordQueued(context.state.pendingReports.find((report) => report.reportId === reportId)!, input.evidence);
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
              context.state.pendingReports.map((report) => [report.reportId, report]),
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
            const partitions = partitionWatchState(context.state, pathById, issueUrlById);
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
          context.state.pendingReports.map((report) => [report.reportId, report]),
        );
        for (const event of reports) {
          const stored = reportsById.get(event.reportId!);
          if (stored) stored.retryReadyAt = retryReadyAt;
        }
        await persist();
      });
    },
  };
}
