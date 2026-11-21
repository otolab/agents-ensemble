import type { SessionObservationSnapshot, SessionResumeStore } from '@agents-ensemble/core/operator-runtime';
import type { RepositoryWatchConfig } from './operator-repository-watch-state.js';
import type {
  OperatorDispatchEvent,
  OperatorDispatchBatch,
  OperatorDispatchState,
  OperatorDispatchQueue,
} from '../dispatch/operator-dispatch.js';

export interface WatchConfig {
  conductorAgentId: string;
  pollIntervalMs: number;
  debounceMs: number;
}

export interface SessionCursor {
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
  recordSchedulingEvent?(event: Record<string, unknown>): void;
  flushSchedulingEvents?(): Promise<void>;
  enqueueIdleCandidate?(input: {
    conductorAgentId: string;
    text: string;
    kind: 'idle_phase' | 'stale_running';
    fingerprint: string;
    evidence?: { phase: 'idle' | 'running'; ageMs: number; thresholdMs: number };
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
