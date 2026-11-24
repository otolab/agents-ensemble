import { parseIssueUrl } from '@agents-ensemble/core/operator-runtime';
import type { ConductorMessageListenConfig, SessionCursor, WatchConfig } from './types.js';

export const WATCH_STATE_VERSION = 1;

export interface OperatorWatchState {
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

export function emptyWatchState(): OperatorWatchState {
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

export function watchStateSessionIds(state: OperatorWatchState): Set<string> {
  return new Set([
    ...Object.keys(state.watches),
    ...Object.keys(state.cursors),
    ...Object.keys(state.messageListeners),
    ...Object.keys(state.messageCursors),
    ...Object.keys(state.idleCandidateFingerprints),
    ...state.pendingReports.map((report) => report.conductorAgentId),
  ]);
}

export function extractWatchStateForSession(
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

export function removeWatchStateForSession(
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

export function summarizeWatchStateBundles(
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

export function mergeWatchStates(
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

export function partitionWatchState(
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

export function issueIdentity(issueUrl: string): string | undefined {
  try {
    const issue = parseIssueUrl(issueUrl);
    return `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`;
  } catch {
    return undefined;
  }
}
