import { createHash } from 'node:crypto';
import type { OperatorAgentSchedulingConfig } from './operator-agent-config.js';
import type {
  OperatorDispatchQueue,
} from './operator-dispatch.js';
import type {
  OperatorIdleCandidateObservation,
  OperatorWatchPool,
} from './types.js';

const MIN_OBSERVATION_FRESHNESS_MS = 10_000;

export interface OperatorIdleCandidate {
  conductorAgentId: string;
  kind: 'idle_phase' | 'stale_running';
  fingerprint: string;
  text: string;
  evaluatedAt: number;
}

export function evaluateOperatorIdleCandidate(
  observation: OperatorIdleCandidateObservation,
  scheduling: Pick<
    Required<OperatorAgentSchedulingConfig>,
    'idlePhaseThresholdMs' | 'staleRunningThresholdMs'
  >,
  now = Date.now(),
): OperatorIdleCandidate | undefined {
  if (
    observation.source !== 'uds' ||
    observation.connectivity !== 'reachable' ||
    !Number.isSafeInteger(observation.checkedAt) ||
    observation.checkedAt > now ||
    !Number.isSafeInteger(observation.pollIntervalMs) ||
    observation.pollIntervalMs <= 0 ||
    now - observation.checkedAt >
      Math.max(
        MIN_OBSERVATION_FRESHNESS_MS,
        observation.pollIntervalMs * 2,
      ) ||
    (observation.lifecycle !== undefined &&
      observation.lifecycle !== 'unknown') ||
    !Number.isSafeInteger(observation.harnessModifiedAt) ||
    observation.harnessModifiedAt === undefined ||
    observation.harnessModifiedAt > observation.checkedAt
  ) {
    return undefined;
  }

  const harnessStateAgeMs = now - observation.harnessModifiedAt;
  if (
    observation.harnessPhase === 'idle' &&
    harnessStateAgeMs >= scheduling.idlePhaseThresholdMs
  ) {
    const fingerprint = fingerprintOf({
      conductorAgentId: observation.conductorAgentId,
      kind: 'idle_phase',
      harnessModifiedAt: observation.harnessModifiedAt,
    });
    return {
      conductorAgentId: observation.conductorAgentId,
      kind: 'idle_phase',
      fingerprint,
      evaluatedAt: now,
      text: [
        '稼働 session の確認候補（保存 phase: idle）',
        `対象: ${observation.issueUrl} (${observation.conductorAgentId})`,
        `SessionResumeStore の harness state 更新時刻: ${formatTimestamp(observation.harnessModifiedAt)}`,
        `live UDS 観測時刻: ${formatTimestamp(observation.checkedAt)}`,
        'これは harness が保存した phase の確認候補です。worker の停止・失敗や、作業の未完了を示すものではありません。',
      ].join('\n'),
    };
  }

  if (
    observation.harnessPhase !== 'running' ||
    !observation.statusLine ||
    !Number.isSafeInteger(observation.statusLine.reportedAt) ||
    observation.statusLine.reportedAt > observation.checkedAt ||
    now - observation.statusLine.reportedAt <
      scheduling.staleRunningThresholdMs
  ) {
    return undefined;
  }

  const fingerprint = fingerprintOf({
    conductorAgentId: observation.conductorAgentId,
    kind: 'stale_running',
    harnessModifiedAt: observation.harnessModifiedAt,
    statusLine: observation.statusLine.text,
    statusLineReportedAt: observation.statusLine.reportedAt,
  });
  const thresholdMinutes = scheduling.staleRunningThresholdMs / 60_000;
  return {
    conductorAgentId: observation.conductorAgentId,
    kind: 'stale_running',
    fingerprint,
    evaluatedAt: now,
    text: [
      `稼働 session の確認候補（statusLine 最終更新から${formatDuration(thresholdMinutes)}以上・要確認）`,
      `対象: ${observation.issueUrl} (${observation.conductorAgentId})`,
      `harness phase: running（state 更新時刻: ${formatTimestamp(observation.harnessModifiedAt)}）`,
      `最終 statusLine 報告: ${formatTimestamp(observation.statusLine.reportedAt)}`,
      `statusLine: ${observation.statusLine.text}`,
      'worker の進捗 heartbeat は観測できていません。長時間の正常処理もあり得るため、停止・失敗・停滞とは断定せず、必要に応じて session を確認してください。',
    ].join('\n'),
  };
}

export interface OperatorIdleCandidateMonitorOptions {
  watchPool: Pick<
    OperatorWatchPool,
    | 'list'
    | 'pollOnce'
    | 'listIdleCandidateObservations'
    | 'enqueueIdleCandidate'
  >;
  dispatchQueue: OperatorDispatchQueue;
  scheduling: Required<OperatorAgentSchedulingConfig>;
  isAgentSendInFlight: () => boolean;
  onError?: (message: string) => void;
  refreshOnGateClear?: (
    knownObservationVersions: ReadonlyMap<string, number>,
  ) => Promise<void>;
}

export interface OperatorIdleCandidateMonitor {
  notifyActivityChanged(): void;
  waitForGateRefresh(): Promise<boolean>;
  close(): void;
}

export const OPERATOR_IDLE_GATE_REFRESH_WAIT_CAP_MS = 1_000;

export function createOperatorIdleCandidateMonitor(
  options: OperatorIdleCandidateMonitorOptions,
): OperatorIdleCandidateMonitor {
  type GateRefreshPass = {
    promise: Promise<void>;
    wait?: Promise<boolean>;
  };
  let closed = false;
  let evaluationInFlight: Promise<void> | undefined;
  let gateRefreshInFlight: GateRefreshPass | undefined;
  let freshObservationVersions: Map<string, number> | undefined;
  let refreshAfterCurrentEvaluation = false;
  const isGateActive = () =>
    options.isAgentSendInFlight() ||
    options.dispatchQueue.pendingUserCount > 0 ||
    options.dispatchQueue.conversationHold ||
    options.dispatchQueue.focusSessionId !== undefined;
  let previousGateActive = isGateActive();

  const evaluate = (refreshCurrentState = false): Promise<void> => {
    if (closed || isGateActive()) return Promise.resolve();
    if (evaluationInFlight) {
      refreshAfterCurrentEvaluation ||= refreshCurrentState;
      return evaluationInFlight;
    }
    evaluationInFlight = (async () => {
      let shouldRefresh = refreshCurrentState;
      do {
        refreshAfterCurrentEvaluation = false;
        if (shouldRefresh) {
          const versionsBeforeRefresh = new Map(
            options.watchPool
              .listIdleCandidateObservations()
              .map((observation) => [
                observation.conductorAgentId,
                observation.observationVersion,
              ]),
          );
          try {
            if (!options.refreshOnGateClear) return;
            await options.refreshOnGateClear(versionsBeforeRefresh);
          } catch (error) {
            options.onError?.(
              `idle candidate refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (closed) return;
          // If another observable gate opened during this poll, retain its
          // freshness boundary and consume the result on the next gate clear.
          freshObservationVersions = versionsBeforeRefresh;
        }
        if (closed || isGateActive()) return;
        const versionsBeforeRefresh = freshObservationVersions;
        const now = Date.now();
        for (const observation of options.watchPool.listIdleCandidateObservations()) {
          if (closed || isGateActive()) return;
          if (
            versionsBeforeRefresh &&
            observation.observationVersion <=
              (versionsBeforeRefresh.get(observation.conductorAgentId) ?? 0)
          ) {
            continue;
          }
          const candidate = evaluateOperatorIdleCandidate(
            observation,
            options.scheduling,
            now,
          );
          if (!candidate) continue;
          if (!options.watchPool.enqueueIdleCandidate) {
            options.onError?.(
              `idle candidate admission is unavailable for ${candidate.conductorAgentId}`,
            );
            continue;
          }
          try {
            await options.watchPool.enqueueIdleCandidate({
              conductorAgentId: candidate.conductorAgentId,
              text: candidate.text,
              kind: candidate.kind,
              fingerprint: candidate.fingerprint,
              eligibleAt: candidate.evaluatedAt,
              shouldAdmit: () =>
                !closed &&
                !isGateActive() &&
                options.watchPool.list().some(
                  (watch) =>
                    watch.conductorAgentId === candidate.conductorAgentId,
                ),
            });
          } catch (error) {
            options.onError?.(
              `idle candidate admission failed for ${candidate.conductorAgentId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (versionsBeforeRefresh === freshObservationVersions) {
          freshObservationVersions = undefined;
        }
        shouldRefresh = refreshAfterCurrentEvaluation;
      } while (shouldRefresh && !closed && !isGateActive());
    })().finally(() => {
      evaluationInFlight = undefined;
    });
    return evaluationInFlight;
  };

  const refreshGate = () => {
    const gateActive = isGateActive();
    if (gateActive) refreshAfterCurrentEvaluation = false;
    if (previousGateActive && !gateActive) {
      if (gateRefreshInFlight) {
        // A timed-out pass remains authoritative until it finishes. A later
        // gate edge must not poll or admit its observation a second time.
        previousGateActive = gateActive;
        return;
      }
      const refresh = evaluate(freshObservationVersions === undefined)
        .catch((error: unknown) => {
          options.onError?.(
            `idle candidate gate refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      const pendingRefresh: GateRefreshPass = {
        promise: Promise.resolve(),
      };
      gateRefreshInFlight = pendingRefresh;
      pendingRefresh.promise = refresh.finally(async () => {
        if (gateRefreshInFlight === pendingRefresh) {
          gateRefreshInFlight = undefined;
        }
        // Cover a gate edge that lands between evaluation completion and
        // this pass's cleanup, without starting another fresh poll.
        if (!closed && !isGateActive() && freshObservationVersions) {
          await evaluate(false);
        }
        options.dispatchQueue.wake();
      });
    }
    previousGateActive = gateActive;
  };
  const unsubscribe = options.dispatchQueue.subscribe(refreshGate);
  const timer = setInterval(() => void evaluate(), options.scheduling.idleReevaluationIntervalMs);
  timer.unref();
  void evaluate();

  return {
    notifyActivityChanged() {
      refreshGate();
    },
    waitForGateRefresh() {
      const pendingRefresh = gateRefreshInFlight;
      if (!pendingRefresh) return Promise.resolve(true);
      if (pendingRefresh.wait) return pendingRefresh.wait;
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          OPERATOR_IDLE_GATE_REFRESH_WAIT_CAP_MS,
        );
        timeout.unref();
      });
      pendingRefresh.wait = Promise.race([
        pendingRefresh.promise.then(() => true),
        deadline,
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      return pendingRefresh.wait;
    },
    close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function formatDuration(minutes: number): string {
  if (Number.isInteger(minutes)) return `${minutes} 分`;
  const totalSeconds = Math.round(minutes * 60);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return remainingSeconds === 0
    ? `${wholeMinutes} 分`
    : `${wholeMinutes} 分 ${remainingSeconds} 秒`;
}
