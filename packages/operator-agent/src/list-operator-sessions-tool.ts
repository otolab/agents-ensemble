import { resolve } from 'node:path';
import {
  listUserLocatedSessionResumeStoresPage,
  harnessPhaseFromLegacyLifecycle,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  parseIssueUrl,
  resolveUserEnsembleRoot,
  userSessionSnapshotPaths,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionLifecycle,
  type SessionStateStore,
  type LocatedSessionResumeStore,
  type SessionResumeStore,
  type SessionResumeStoreDuplicateDiagnostic,
  type HarnessPhase,
} from '@agents-ensemble/core/operator-runtime';
import type { OperatorSessionLiveStatus } from './operator-watch-pool.js';
import {
  normalizeRepositoryPattern,
  repositoryMatchesPatterns,
} from './operator-agent-config.js';

export const LIST_OPERATOR_SESSIONS_TOOL = 'list_operator_sessions';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SESSION_LIFECYCLES: SessionLifecycle[] = [
  'closed',
  'exited',
  'interrupted',
  'unknown',
];

interface OperatorSessionSummary {
  /** Kept as an alias for callers of the original list_operator_sessions shape. */
  agentId: string;
  conductorAgentId: string;
  issueRef: { owner: string; repo: string; number: number } | null;
  issueUrl: string;
  conductorBackend: string;
  profile: string;
  updatedAt: number;
  statusLine: string | null;
  reportedAt: number | null;
  statusLineHistory: SessionStateStore['history'];
  lifecycle: SessionLifecycle;
  liveControlPathRecorded: boolean;
  persisted: {
    harnessPhase: HarnessPhase | null;
    modifiedAt: number | null;
    source: 'resume_store' | 'legacy_lifecycle';
  };
  live: {
    connectivity: OperatorSessionLiveStatus['connectivity'];
    checkedAt: number | null;
  };
  posture: 'watch' | 'interact' | 'resume' | 'purge' | 'indeterminate';
  coherence: 'ok' | 'conflict' | 'insufficient_data';
  coherenceReasons?: string[];
  openQuestionCount: number | null;
  workers: string[];
  configuredWorkers: Array<{ name: string; kind: string }>;
  workersWithoutSavedSession: string[];
  openQuestionHistoryStatus: 'available' | 'unavailable';
  openQuestionHistorySource:
    | 'open_questions_yaml'
    | 'resume_store_compatibility'
    | 'unavailable';
  openQuestionHistoryReason?: string;
  openQuestionHistory: SessionResumeStore['openQuestions'];
  openQuestions: Array<{
    id: string;
    question: string;
    responseType: string;
    context?: string;
    relatedPermissionId?: string;
  }>;
  answeredQuestionCount: number | null;
}

type SessionSort = 'updatedAtDesc' | 'updatedAtAsc';

interface SessionListSnapshot {
  located: LocatedSessionResumeStore;
  resumeStore: SessionResumeStore;
  status: SessionStateStore | undefined;
  questionHistory: OpenQuestionHistory;
}

interface OpenQuestionHistory {
  status: 'available' | 'unavailable';
  source:
    | 'open_questions_yaml'
    | 'resume_store_compatibility'
    | 'unavailable';
  questions: SessionResumeStore['openQuestions'];
  reason?: string;
}

interface OperatorSessionListCursor {
  version: 1;
  sort: SessionSort;
  scope: string;
  updatedAt: number;
  issueKey: string;
  conductorAgentId: string;
}

export interface OperatorSessionListScope {
  userEnsembleRoot: string;
  profileIncludes?: readonly string[];
  repoFilters?: readonly string[];
}

/** Build a read-only tool over the user-scoped saved conductor session data. */
export function createListOperatorSessionsTool(
  scope: string | OperatorSessionListScope,
  getLiveStatus?: (
    conductorAgentId: string,
  ) => OperatorSessionLiveStatus | undefined,
  onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void,
): ConductorTool {
  const root = resolve(
    typeof scope === 'string'
      ? resolveUserEnsembleRoot()
      : scope.userEnsembleRoot,
  );
  const profileIncludes =
    typeof scope === 'string' ? undefined : scope.profileIncludes;
  const repoFilters = typeof scope === 'string' ? undefined : scope.repoFilters;
  return {
    name: LIST_OPERATOR_SESSIONS_TOOL,
    description:
      'Read saved SessionResumeStore records and session state from the user-scoped repository session store. The results are snapshots, not live process status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum number of recent sessions to return (default ${DEFAULT_LIMIT}).`,
        },
        cursor: {
          type: 'string',
          description: 'Opaque cursor returned by the previous page.',
        },
        githubRepo: {
          type: 'string',
          description: 'Optional exact owner/repo filter.',
        },
        issueUrl: {
          type: 'string',
          description: 'Optional exact GitHub Issue URL filter.',
        },
        conductorAgentId: {
          type: 'string',
          description: 'Optional exact run id filter from the session summary.',
        },
        sort: {
          type: 'string',
          enum: ['updatedAtDesc', 'updatedAtAsc'],
          description: 'Sort by the SessionResumeStore updatedAt value (default updatedAtDesc).',
        },
        hasStatusLine: {
          type: 'boolean',
          description: 'Filter for sessions with (true) or without (false) a saved statusLine.',
        },
        lifecycle: {
          type: 'string',
          enum: SESSION_LIFECYCLES,
          description: 'Filter by saved lifecycle; legacy sessions are unknown.',
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const limit = resolveLimit(args.limit);
      const sort = resolveSort(args.sort);
      const hasStatusLine = resolveHasStatusLine(args.hasStatusLine);
      const lifecycle = resolveLifecycle(args.lifecycle);
      const githubRepo = resolveGithubRepo(args.githubRepo);
      const issueUrl = resolveIssueUrl(args.issueUrl);
      const conductorAgentId = resolveConductorAgentId(
        args.conductorAgentId,
      );
      const dataAsOf = new Date().toISOString();
      const resumeStores = (
        await listUserLocatedSessionResumeStoresPage(
          { issueUrl, conductorAgentId },
          { userEnsembleRoot: root, onDuplicate },
        )
      ).sessions;
      const normalizedRepoFilters = repoFilters?.length
        ? repoFilters.map((pattern) => normalizeRepositoryPattern(pattern))
        : undefined;
      const normalizedProfileIncludes = profileIncludes?.length
        ? profileIncludes.map((pattern) => normalizeRepositoryPattern(pattern))
        : undefined;
      const snapshots = await Promise.all(
        resumeStores.map(async (located) => ({
          located,
          resumeStore: located.resumeStore,
          status: await loadStatusLine(root, located),
          questionHistory: await loadQuestionHistory(root, located),
        })),
      );
      const filtered = snapshots.filter(({ resumeStore, status }) => {
        const repository = repositoryForIssueUrl(resumeStore.issueUrl);
        if (githubRepo && repository !== githubRepo) return false;
        if (
          normalizedProfileIncludes !== undefined &&
          !repositoryMatchesPatterns(repository, normalizedProfileIncludes)
        ) {
          return false;
        }
        if (
          normalizedRepoFilters !== undefined &&
          !repositoryMatchesPatterns(repository, normalizedRepoFilters)
        ) {
          return false;
        }
        if (
          hasStatusLine !== undefined &&
          Boolean(status) !== hasStatusLine
        ) {
          return false;
        }
        const sessionLifecycle = resumeStore.lifecycle ?? 'unknown';
        return lifecycle === undefined || sessionLifecycle === lifecycle;
      });
      filtered.sort((left, right) => {
        return compareSnapshots(left, right, sort);
      });
      const cursorScope = JSON.stringify({
        sort,
        githubRepo: githubRepo ?? null,
        issueUrl: issueUrl ?? null,
        conductorAgentId: conductorAgentId ?? null,
        hasStatusLine: hasStatusLine ?? null,
        lifecycle: lifecycle ?? null,
        profileIncludes: normalizedProfileIncludes ?? null,
        repoFilters: normalizedRepoFilters ?? null,
      });
      const cursor = resolveListCursor(args.cursor, sort, cursorScope);
      const remaining = cursor
        ? filtered.filter(
            (snapshot) => compareSnapshotToCursor(snapshot, cursor, sort) > 0,
          )
        : filtered;
      const page = remaining.slice(0, limit);
      const nextCursor =
        remaining.length > page.length
          ? encodeListCursor(page.at(-1)!, sort, cursorScope)
          : undefined;
      const sessions = page.map(({ resumeStore, status, questionHistory }) =>
          summarizeSession(
            resumeStore,
            status,
            questionHistory,
            getLiveStatus?.(resumeStore.conductorAgentId),
          ),
        );
      const payload = {
        dataAsOf,
        total: filtered.length,
        returned: sessions.length,
        ...(nextCursor ? { nextCursor } : {}),
        sessions,
      };
      const structuredContent = payload as unknown as Record<string, ConductorJsonValue>;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent,
      };
    },
  };
}

async function loadQuestionHistory(
  userEnsembleRoot: string,
  located: LocatedSessionResumeStore,
): Promise<OpenQuestionHistory> {
  try {
    const paths = userSessionSnapshotPaths(
      userEnsembleRoot,
      located,
      'open-questions',
    );
    for (const path of paths) {
      const snapshot = await loadOpenQuestionsStore(path);
      if (snapshot) {
        return {
          status: 'available',
          source: 'open_questions_yaml',
          questions: snapshot.openQuestions,
        };
      }
    }
    return {
      status: 'available',
      source: 'resume_store_compatibility',
      questions: located.resumeStore.openQuestions,
    };
  } catch {
    return {
      status: 'unavailable',
      source: 'unavailable',
      questions: [],
      reason: '保存済み Open Questions YAML を読み取れません。',
    };
  }
}

function resolveLimit(value: ConductorJsonValue | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT
  ) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function resolveSort(value: ConductorJsonValue | undefined): SessionSort {
  if (value === undefined) return 'updatedAtDesc';
  if (value === 'updatedAtDesc' || value === 'updatedAtAsc') return value;
  throw new Error('sort must be updatedAtDesc or updatedAtAsc');
}

function resolveHasStatusLine(
  value: ConductorJsonValue | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error('hasStatusLine must be a boolean');
  }
  return value;
}

function resolveLifecycle(
  value: ConductorJsonValue | undefined,
): SessionLifecycle | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !SESSION_LIFECYCLES.includes(value as SessionLifecycle)
  ) {
    throw new Error(
      `lifecycle must be one of ${SESSION_LIFECYCLES.join(', ')}`,
    );
  }
  return value as SessionLifecycle;
}

async function loadStatusLine(
  userEnsembleRoot: string,
  located: LocatedSessionResumeStore,
): Promise<SessionStateStore | undefined> {
  try {
    const paths = userSessionSnapshotPaths(
      userEnsembleRoot,
      located,
      'session-state',
    );
    for (const path of paths) {
      const status = await loadSessionStateStore(path);
      if (status) return status;
    }
    return undefined;
  } catch {
    // Status reporting is an optional operator snapshot. A missing, partial, or
    // unsupported file must not hide an otherwise readable session.
    return undefined;
  }
}

function resolveGithubRepo(value: ConductorJsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('githubRepo must be an owner/repo string.');
  }
  const normalized = normalizeRepositoryPattern(value);
  if (normalized.endsWith('/*')) {
    throw new Error('githubRepo must be an exact owner/repo, not owner/*.');
  }
  return normalized;
}

function resolveIssueUrl(
  value: ConductorJsonValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('issueUrl must be a non-empty GitHub Issue URL.');
  }
  parseIssueUrl(value);
  return value.trim();
}

function resolveConductorAgentId(
  value: ConductorJsonValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('conductorAgentId must be a non-empty string.');
  }
  return value.trim();
}

function repositoryForIssueUrl(issueUrl: string): string {
  try {
    const issue = parseIssueUrl(issueUrl);
    return `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}`;
  } catch {
    return '';
  }
}

function issueKeyForSnapshot(snapshot: SessionListSnapshot): string {
  try {
    const issue = parseIssueUrl(snapshot.resumeStore.issueUrl);
    return `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`;
  } catch {
    return snapshot.resumeStore.issueUrl.toLowerCase();
  }
}

function compareSnapshots(
  left: SessionListSnapshot,
  right: SessionListSnapshot,
  sort: SessionSort,
): number {
  const direction = sort === 'updatedAtDesc' ? -1 : 1;
  return (
    direction * (left.resumeStore.updatedAt - right.resumeStore.updatedAt) ||
    issueKeyForSnapshot(left).localeCompare(issueKeyForSnapshot(right)) ||
    left.resumeStore.conductorAgentId.localeCompare(
      right.resumeStore.conductorAgentId,
    )
  );
}

function compareSnapshotToCursor(
  snapshot: SessionListSnapshot,
  cursor: OperatorSessionListCursor,
  sort: SessionSort,
): number {
  const direction = sort === 'updatedAtDesc' ? -1 : 1;
  return (
    direction * (snapshot.resumeStore.updatedAt - cursor.updatedAt) ||
    issueKeyForSnapshot(snapshot).localeCompare(cursor.issueKey) ||
    snapshot.resumeStore.conductorAgentId.localeCompare(
      cursor.conductorAgentId,
    )
  );
}

function encodeListCursor(
  snapshot: SessionListSnapshot,
  sort: SessionSort,
  scope: string,
): string {
  const cursor: OperatorSessionListCursor = {
    version: 1,
    sort,
    scope,
    updatedAt: snapshot.resumeStore.updatedAt,
    issueKey: issueKeyForSnapshot(snapshot),
    conductorAgentId: snapshot.resumeStore.conductorAgentId,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function resolveListCursor(
  value: ConductorJsonValue | undefined,
  sort: SessionSort,
  scope: string,
): OperatorSessionListCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('cursor must be a string.');
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid operator session cursor.');
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    (cursor as Record<string, unknown>).version !== 1 ||
    (cursor as Record<string, unknown>).sort !== sort ||
    (cursor as Record<string, unknown>).scope !== scope ||
    typeof (cursor as Record<string, unknown>).updatedAt !== 'number' ||
    !Number.isFinite((cursor as Record<string, unknown>).updatedAt) ||
    typeof (cursor as Record<string, unknown>).issueKey !== 'string' ||
    typeof (cursor as Record<string, unknown>).conductorAgentId !== 'string'
  ) {
    throw new Error(
      'Invalid operator session cursor or it does not match the current filters.',
    );
  }
  const record = cursor as Record<string, unknown>;
  return {
    version: 1,
    sort,
    scope,
    updatedAt: record.updatedAt as number,
    issueKey: record.issueKey as string,
    conductorAgentId: record.conductorAgentId as string,
  };
}

function summarizeSession(
  resumeStore: SessionResumeStore,
  status: SessionStateStore | undefined,
  questionHistory: OpenQuestionHistory,
  cachedLiveStatus?: OperatorSessionLiveStatus,
): OperatorSessionSummary {
  let issueRef: OperatorSessionSummary['issueRef'] = null;
  try {
    const parsed = parseIssueUrl(resumeStore.issueUrl);
    issueRef = {
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
    };
  } catch {
    // Keep the original issueUrl visible for legacy or externally produced data.
  }
  const openQuestions =
    questionHistory.status === 'available'
      ? questionHistory.questions.filter(
          (question) => question.status === 'open',
        )
      : [];
  const configuredWorkers = resumeStore.profile.workers.map((worker) => ({
    name: worker.name,
    kind: worker.kind,
  }));
  const harnessPhase =
    resumeStore.harnessPhase ??
    harnessPhaseFromLegacyLifecycle(resumeStore.lifecycle);
  const persistedModifiedAt = resumeStore.harnessPhase
    ? (resumeStore.modifiedAt ?? null)
    : null;
  const live = {
    connectivity: cachedLiveStatus?.connectivity ?? ('unknown' as const),
    checkedAt: cachedLiveStatus?.checkedAt ?? null,
  };
  const projection = projectSessionPosture(
    harnessPhase,
    live.connectivity,
    live.checkedAt,
    persistedModifiedAt,
    cachedLiveStatus?.unreachableSince ?? null,
  );

  return {
    agentId: resumeStore.conductorAgentId,
    conductorAgentId: resumeStore.conductorAgentId,
    issueRef,
    issueUrl: resumeStore.issueUrl,
    conductorBackend: resumeStore.conductorBackend ?? 'cursor',
    profile:
      resumeStore.profile.meta?.title ??
      resumeStore.profilePath ??
      'unknown',
    updatedAt: resumeStore.updatedAt,
    statusLine: status?.current.statusLine ?? null,
    reportedAt: status?.current.reportedAt ?? null,
    statusLineHistory: status?.history ?? [],
    lifecycle: resumeStore.lifecycle ?? 'unknown',
    liveControlPathRecorded: Boolean(resumeStore.harnessSocketPath),
    persisted: {
      harnessPhase,
      modifiedAt: persistedModifiedAt,
      source: resumeStore.harnessPhase ? 'resume_store' : 'legacy_lifecycle',
    },
    live,
    ...projection,
    openQuestionCount:
      questionHistory.status === 'available' ? openQuestions.length : null,
    workers: Object.keys(resumeStore.workers).sort(),
    configuredWorkers,
    workersWithoutSavedSession: configuredWorkers
      .map((worker) => worker.name)
      .filter((workerName) => !resumeStore.workers[workerName]),
    openQuestionHistoryStatus: questionHistory.status,
    openQuestionHistorySource: questionHistory.source,
    ...(questionHistory.reason
      ? { openQuestionHistoryReason: questionHistory.reason }
      : {}),
    openQuestionHistory: questionHistory.questions,
    openQuestions: openQuestions.map((question) => ({
      id: question.id,
      question: question.question,
      responseType: question.responseType,
      ...(question.context ? { context: question.context } : {}),
      ...(question.relatedPermissionId
        ? { relatedPermissionId: question.relatedPermissionId }
        : {}),
    })),
    answeredQuestionCount:
      questionHistory.status === 'available'
        ? questionHistory.questions.filter(
            (question) => question.status === 'answered',
          ).length
        : null,
  };
}

const ACTIVE_UNREACHABLE_GRACE_MS = 30_000;

function projectSessionPosture(
  phase: HarnessPhase | null,
  connectivity: OperatorSessionLiveStatus['connectivity'],
  checkedAt: number | null,
  modifiedAt: number | null,
  unreachableSince: number | null,
): Pick<
  OperatorSessionSummary,
  'posture' | 'coherence' | 'coherenceReasons'
> {
  const liveObservationPredatesPhase =
    checkedAt !== null &&
    modifiedAt !== null &&
    checkedAt < modifiedAt;
  const projectedConnectivity = liveObservationPredatesPhase
    ? 'unknown'
    : connectivity;

  if (!phase) {
    return {
      posture: 'indeterminate',
      coherence: 'insufficient_data',
      coherenceReasons: ['phase_unavailable'],
    };
  }

  if (phase === 'running' || phase === 'idle') {
    if (projectedConnectivity === 'reachable') {
      return {
        posture: phase === 'running' ? 'interact' : 'watch',
        coherence: 'ok',
      };
    }
    if (
      projectedConnectivity === 'unreachable' &&
      unreachableSince !== null &&
      Date.now() - unreachableSince >= ACTIVE_UNREACHABLE_GRACE_MS
    ) {
      return {
        posture: 'indeterminate',
        coherence: 'conflict',
        coherenceReasons: ['active_but_unreachable'],
      };
    }
    return {
      posture: 'indeterminate',
      coherence: 'insufficient_data',
      coherenceReasons: [
        liveObservationPredatesPhase
          ? 'live_observation_predates_phase'
          : projectedConnectivity === 'unreachable'
            ? 'active_connectivity_grace'
            : 'live_connectivity_unknown',
      ],
    };
  }

  if (projectedConnectivity === 'reachable') {
    return {
      posture: 'indeterminate',
      coherence: 'conflict',
      coherenceReasons: ['terminal_but_live_control'],
    };
  }
  if (projectedConnectivity === 'unknown') {
    return {
      posture: phase === 'exit' ? 'purge' : 'resume',
      coherence: 'insufficient_data',
      coherenceReasons: [
        liveObservationPredatesPhase
          ? 'live_observation_predates_phase'
          : 'terminal_live_connectivity_unknown',
      ],
    };
  }
  return {
    posture: phase === 'exit' ? 'purge' : 'resume',
    coherence: 'ok',
  };
}
