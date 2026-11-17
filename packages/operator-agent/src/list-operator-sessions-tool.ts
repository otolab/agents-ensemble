import { resolve } from 'node:path';
import {
  GitHubApiError,
  isGitHubAuthError,
  isGitHubRateLimitError,
  type GitHubClient,
  type GitHubIssuePullRequestSummaries,
} from '@agents-ensemble/core';
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
import type {
  OperatorSessionLiveStatus,
  OperatorSessionTrackingInfo,
} from './operator-watch-pool.js';
import {
  normalizeRepositoryPattern,
  repositoryMatchesPatterns,
} from './operator-agent-config.js';

export const LIST_OPERATOR_SESSIONS_TOOL = 'list_operator_sessions';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_GITHUB_ISSUES_PER_PAGE = 5;
const GITHUB_SUMMARY_CACHE_TTL_MS = 30_000;
const LIVE_STATUS_FRESHNESS_MS = 10_000;
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
  updatedAtMeaning: 'resume_store_flush_time';
  statusLine: string | null;
  reportedAt: number | null;
  statusLineSource: 'conductor_report' | 'unavailable';
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
    lastKnownConnectivity: OperatorSessionLiveStatus['connectivity'] | null;
    freshness: 'fresh' | 'stale' | 'not_observed';
    ageMs: number | null;
  };
  discovery: {
    firstObservedAt: number | null;
    timeSource: 'repository_watch_first_observed' | 'unavailable';
  };
  repositoryScan: OperatorSessionTrackingInfo['repositoryScan'];
  watch: {
    repositoryEnabled: boolean;
    enabled: boolean;
    source: 'manual' | 'repository_auto' | null;
    reason: OperatorSessionTrackingInfo['watchReason'];
    pollIntervalMs: number | null;
  };
  openQuestionObservation: {
    status: 'observed' | 'not_observed';
    current: {
      count: number;
      checkedAt: number;
      source: 'uds' | 'resume_store';
    } | null;
    previous: {
      count: number;
      checkedAt: number;
      source: 'uds' | 'resume_store';
    } | null;
    delta: number | null;
    comparedAt: number | null;
  };
  pullRequests: GitHubPullRequestSummaryView;
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

type SessionSort =
  | 'firstObservedAtDesc'
  | 'firstObservedAtAsc'
  | 'updatedAtDesc'
  | 'updatedAtAsc';

interface SessionListSnapshot {
  located: LocatedSessionResumeStore;
  resumeStore: SessionResumeStore;
  status: SessionStateStore | undefined;
  tracking: OperatorSessionTrackingInfo;
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
  version: 2;
  sort: SessionSort;
  scope: string;
  sortValue: number | null;
  issueKey: string;
  conductorAgentId: string;
}

interface GitHubPullRequestSummaryView {
  status:
    | 'available'
    | 'none'
    | 'partial'
    | 'stale'
    | 'unavailable'
    | 'not_checked'
    | 'not_requested';
  source: 'github_api' | null;
  checkedAt: number | null;
  freshness: 'fresh' | 'stale' | 'not_observed';
  reason?: string;
  refreshFailure?: string;
  items: Array<{
    number: number;
    title: string;
    url: string;
    state: string;
    head: { ref: string; sha: string };
    review: {
      decision: string | null;
      status: 'available' | 'unknown';
      source: 'github_api';
    };
    checks: {
      status: 'available' | 'none' | 'truncated';
      source: 'github_api';
      items: GitHubIssuePullRequestSummaries['pullRequests'][number]['checks'];
    };
  }>;
}

interface CachedGitHubSummary {
  checkedAt?: number;
  data?: GitHubIssuePullRequestSummaries;
  failure?: string;
  failureAt?: number;
}

export interface OperatorSessionListScope {
  userEnsembleRoot: string;
  profileIncludes?: readonly string[];
  repoFilters?: readonly string[];
  getGitHubClient?: () => Promise<GitHubClient>;
}

/** Build a read-only tool over the user-scoped saved conductor session data. */
export function createListOperatorSessionsTool(
  scope: string | OperatorSessionListScope,
  getLiveStatus?: (
    conductorAgentId: string,
  ) => OperatorSessionLiveStatus | undefined,
  onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void,
  getSessionTrackingInfo?: (
    conductorAgentId: string,
    issueUrl: string,
  ) => OperatorSessionTrackingInfo,
): ConductorTool {
  const root = resolve(
    typeof scope === 'string'
      ? resolveUserEnsembleRoot()
      : scope.userEnsembleRoot,
  );
  const profileIncludes =
    typeof scope === 'string' ? undefined : scope.profileIncludes;
  const repoFilters = typeof scope === 'string' ? undefined : scope.repoFilters;
  const getGitHubClient =
    typeof scope === 'string' ? undefined : scope.getGitHubClient;
  const githubSummaryCache = new Map<string, CachedGitHubSummary>();
  return {
    name: LIST_OPERATOR_SESSIONS_TOOL,
    description:
      'List one row per saved Issue run. Separates persisted harness phase from timestamped live observation; includes repository discovery/watch state, observed Open Question count changes, and bounded GitHub pull-request head/check/review summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum number of sessions to return (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}).`,
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
          enum: [
            'firstObservedAtDesc',
            'firstObservedAtAsc',
            'updatedAtDesc',
            'updatedAtAsc',
          ],
          description:
            'Sort by repository-watch first-observed time (default firstObservedAtDesc; unknown times last) or by SessionResumeStore flush time. updatedAt is not a run creation time.',
        },
        includeGithub: {
          type: 'boolean',
          description:
            'Include linked pull-request summaries from GitHub (default true). At most five distinct Issues are queried per page; cached results are reused for 30 seconds.',
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
      const includeGithub = resolveIncludeGithub(args.includeGithub);
      const githubRepo = resolveGithubRepo(args.githubRepo);
      const issueUrl = resolveIssueUrl(args.issueUrl);
      const conductorAgentId = resolveConductorAgentId(
        args.conductorAgentId,
      );
      const dataAsOf = new Date().toISOString();
      const normalizedRepoFilters = repoFilters?.length
        ? repoFilters.map((pattern) => normalizeRepositoryPattern(pattern))
        : undefined;
      const normalizedProfileIncludes = profileIncludes?.length
        ? profileIncludes.map((pattern) => normalizeRepositoryPattern(pattern))
        : undefined;
      const snapshots: SessionListSnapshot[] = [];
      let storeCursor: string | undefined;
      do {
        const page = await listUserLocatedSessionResumeStoresPage(
          {
            ...(githubRepo ? { githubRepo } : {}),
            ...(issueUrl ? { issueUrl } : {}),
            ...(conductorAgentId ? { conductorAgentId } : {}),
            limit: 500,
            ...(storeCursor ? { cursor: storeCursor } : {}),
          },
          { userEnsembleRoot: root, onDuplicate },
        );
        snapshots.push(
          ...(await Promise.all(
            page.sessions.map(async (located) => ({
              located,
              resumeStore: located.resumeStore,
              status: await loadStatusLine(root, located),
              tracking:
                getSessionTrackingInfo?.(
                  located.resumeStore.conductorAgentId,
                  located.resumeStore.issueUrl,
                ) ?? emptyTrackingInfo(),
            })),
          )),
        );
        storeCursor = page.nextCursor;
      } while (storeCursor);
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
      const pageWithQuestions = await Promise.all(
        page.map(async (snapshot) => ({
          ...snapshot,
          questionHistory: await loadQuestionHistory(root, snapshot.located),
        })),
      );
      const pullRequests = await loadPullRequestSummaries(
        pageWithQuestions,
        includeGithub,
        getGitHubClient,
        githubSummaryCache,
      );
      const sessions = pageWithQuestions.map(
        ({ resumeStore, status, questionHistory, tracking }) =>
          summarizeSession(
            resumeStore,
            status,
            questionHistory,
            getLiveStatus?.(resumeStore.conductorAgentId),
            tracking,
            pullRequests.get(issueKeyForResumeStore(resumeStore.issueUrl)) ??
              notRequestedGitHubSummary(),
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
  if (value === undefined) return 'firstObservedAtDesc';
  if (
    value === 'firstObservedAtDesc' ||
    value === 'firstObservedAtAsc' ||
    value === 'updatedAtDesc' ||
    value === 'updatedAtAsc'
  ) {
    return value;
  }
  throw new Error(
    'sort must be firstObservedAtDesc, firstObservedAtAsc, updatedAtDesc, or updatedAtAsc',
  );
}

function resolveIncludeGithub(
  value: ConductorJsonValue | undefined,
): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error('includeGithub must be a boolean');
  }
  return value;
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
  const direction = sort.endsWith('Desc') ? -1 : 1;
  return (
    compareSortValues(
      getSnapshotSortValue(left, sort),
      getSnapshotSortValue(right, sort),
      direction,
    ) ||
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
  const direction = sort.endsWith('Desc') ? -1 : 1;
  return (
    compareSortValues(
      getSnapshotSortValue(snapshot, sort),
      cursor.sortValue,
      direction,
    ) ||
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
    version: 2,
    sort,
    scope,
    sortValue: getSnapshotSortValue(snapshot, sort),
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
    (cursor as Record<string, unknown>).version !== 2 ||
    (cursor as Record<string, unknown>).sort !== sort ||
    (cursor as Record<string, unknown>).scope !== scope ||
    !(
      (cursor as Record<string, unknown>).sortValue === null ||
      (typeof (cursor as Record<string, unknown>).sortValue === 'number' &&
        Number.isFinite((cursor as Record<string, unknown>).sortValue))
    ) ||
    typeof (cursor as Record<string, unknown>).issueKey !== 'string' ||
    typeof (cursor as Record<string, unknown>).conductorAgentId !== 'string'
  ) {
    throw new Error(
      'Invalid operator session cursor or it does not match the current filters.',
    );
  }
  const record = cursor as Record<string, unknown>;
  return {
    version: 2,
    sort,
    scope,
    sortValue: record.sortValue as number | null,
    issueKey: record.issueKey as string,
    conductorAgentId: record.conductorAgentId as string,
  };
}

function getSnapshotSortValue(
  snapshot: SessionListSnapshot,
  sort: SessionSort,
): number | null {
  return sort.startsWith('firstObservedAt')
    ? snapshot.tracking.firstObservedAt
    : snapshot.resumeStore.updatedAt;
}

function compareSortValues(
  left: number | null,
  right: number | null,
  direction: -1 | 1,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction * (left - right);
}

function summarizeSession(
  resumeStore: SessionResumeStore,
  status: SessionStateStore | undefined,
  questionHistory: OpenQuestionHistory,
  cachedLiveStatus?: OperatorSessionLiveStatus,
  tracking: OperatorSessionTrackingInfo = emptyTrackingInfo(),
  pullRequests: GitHubPullRequestSummaryView = notRequestedGitHubSummary(),
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
  const liveCheckedAt = cachedLiveStatus?.checkedAt ?? null;
  const liveAgeMs =
    liveCheckedAt === null ? null : Math.max(0, Date.now() - liveCheckedAt);
  const liveFreshness: OperatorSessionSummary['live']['freshness'] =
    liveCheckedAt === null
      ? 'not_observed'
      : liveAgeMs! > LIVE_STATUS_FRESHNESS_MS
        ? 'stale'
        : 'fresh';
  const live = {
    connectivity:
      liveFreshness === 'stale'
        ? ('unknown' as const)
        : cachedLiveStatus?.connectivity ?? ('unknown' as const),
    checkedAt: liveCheckedAt,
    lastKnownConnectivity: cachedLiveStatus?.connectivity ?? null,
    freshness: liveFreshness,
    ageMs: liveAgeMs,
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
    updatedAtMeaning: 'resume_store_flush_time',
    statusLine: status?.current.statusLine ?? null,
    reportedAt: status?.current.reportedAt ?? null,
    statusLineSource: status ? 'conductor_report' : 'unavailable',
    statusLineHistory: status?.history ?? [],
    lifecycle: resumeStore.lifecycle ?? 'unknown',
    liveControlPathRecorded: Boolean(resumeStore.harnessSocketPath),
    persisted: {
      harnessPhase,
      modifiedAt: persistedModifiedAt,
      source: resumeStore.harnessPhase ? 'resume_store' : 'legacy_lifecycle',
    },
    live,
    discovery: {
      firstObservedAt: tracking.firstObservedAt,
      timeSource:
        tracking.firstObservedAt === null
          ? 'unavailable'
          : 'repository_watch_first_observed',
    },
    repositoryScan: tracking.repositoryScan,
    watch: {
      repositoryEnabled: tracking.repositoryWatchEnabled,
      enabled: tracking.watchEnabled,
      source: tracking.watchSource,
      reason: tracking.watchReason,
      pollIntervalMs: tracking.pollIntervalMs,
    },
    openQuestionObservation: {
      status: tracking.questionCountObservation ? 'observed' : 'not_observed',
      current: tracking.questionCountObservation?.current ?? null,
      previous: tracking.questionCountObservation?.previous ?? null,
      delta:
        tracking.questionCountObservation?.previous === undefined
          ? null
          : tracking.questionCountObservation.current.count -
            tracking.questionCountObservation.previous.count,
      comparedAt:
        tracking.questionCountObservation?.previous?.checkedAt ?? null,
    },
    pullRequests,
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

function emptyTrackingInfo(): OperatorSessionTrackingInfo {
  return {
    firstObservedAt: null,
    repositoryWatchEnabled: false,
    repositoryScan: {
      status: 'not_observed',
      checkedAt: null,
      error: null,
    },
    watchEnabled: false,
    watchSource: null,
    watchReason: 'not_registered',
    pollIntervalMs: null,
  };
}

function notRequestedGitHubSummary(): GitHubPullRequestSummaryView {
  return {
    status: 'not_requested',
    source: null,
    checkedAt: null,
    freshness: 'not_observed',
    items: [],
  };
}

function issueKeyForResumeStore(issueUrl: string): string {
  try {
    const issue = parseIssueUrl(issueUrl);
    return `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`;
  } catch {
    return issueUrl.toLowerCase();
  }
}

async function loadPullRequestSummaries(
  snapshots: readonly SessionListSnapshot[],
  includeGithub: boolean,
  getGitHubClient: (() => Promise<GitHubClient>) | undefined,
  cache: Map<string, CachedGitHubSummary>,
): Promise<Map<string, GitHubPullRequestSummaryView>> {
  const result = new Map<string, GitHubPullRequestSummaryView>();
  const uniqueIssues = new Map<
    string,
    { owner: string; repo: string; number: number }
  >();
  for (const snapshot of snapshots) {
    const key = issueKeyForResumeStore(snapshot.resumeStore.issueUrl);
    if (!includeGithub) {
      result.set(key, notRequestedGitHubSummary());
      continue;
    }
    if (uniqueIssues.has(key)) continue;
    try {
      const issue = parseIssueUrl(snapshot.resumeStore.issueUrl);
      uniqueIssues.set(key, {
        owner: issue.owner,
        repo: issue.repo,
        number: issue.number,
      });
    } catch {
      result.set(key, unavailableGitHubSummary('invalid_issue_url'));
    }
  }
  if (!includeGithub) return result;

  const now = Date.now();
  const needsRefresh: string[] = [];
  for (const key of uniqueIssues.keys()) {
    const cached = cache.get(key);
    if (
      cached?.data &&
      cached.checkedAt !== undefined &&
      now - cached.checkedAt < GITHUB_SUMMARY_CACHE_TTL_MS
    ) {
      result.set(key, toGitHubSummaryView(cached.data, cached.checkedAt));
      continue;
    }
    if (
      cached?.failure &&
      cached.failureAt !== undefined &&
      now - cached.failureAt < GITHUB_SUMMARY_CACHE_TTL_MS
    ) {
      result.set(key, cached.data && cached.checkedAt !== undefined
        ? toGitHubSummaryView(
            cached.data,
            cached.checkedAt,
            'stale',
            cached.failure,
          )
        : unavailableGitHubSummary(cached.failure));
      continue;
    }
    needsRefresh.push(key);
  }

  const refreshKeys = needsRefresh.slice(0, MAX_GITHUB_ISSUES_PER_PAGE);
  for (const key of needsRefresh.slice(MAX_GITHUB_ISSUES_PER_PAGE)) {
    const cached = cache.get(key);
    result.set(
      key,
      cached?.data && cached.checkedAt !== undefined
        ? toGitHubSummaryView(
            cached.data,
            cached.checkedAt,
            'stale',
            'per_page_issue_limit',
          )
        : {
            status: 'not_checked',
            source: null,
            checkedAt: null,
            freshness: 'not_observed',
            reason: 'per_page_issue_limit',
            items: [],
          },
    );
  }
  if (refreshKeys.length === 0) return result;

  let client: GitHubClient | undefined;
  let clientFailure: string | undefined;
  try {
    if (!getGitHubClient) {
      clientFailure = 'not_configured';
    } else {
      client = await getGitHubClient();
    }
  } catch (error) {
    clientFailure = classifyGitHubFailure(error);
  }
  if (!client || typeof client.getIssuePullRequestSummaries !== 'function') {
    const failure = clientFailure ?? 'summary_api_unavailable';
    for (const key of refreshKeys) {
      result.set(
        key,
        recordGitHubFailure(key, failure, cache, now),
      );
    }
    return result;
  }

  await Promise.all(
    refreshKeys.map(async (key) => {
      const issue = uniqueIssues.get(key)!;
      const previous = cache.get(key);
      try {
        const data = await client!.getIssuePullRequestSummaries!(
          issue.owner,
          issue.repo,
          issue.number,
        );
        const checkedAt = Date.now();
        cache.set(key, { data, checkedAt });
        result.set(key, toGitHubSummaryView(data, checkedAt));
      } catch (error) {
        result.set(
          key,
          recordGitHubFailure(
            key,
            classifyGitHubFailure(error),
            cache,
            Date.now(),
            previous,
          ),
        );
      }
    }),
  );
  return result;
}

function recordGitHubFailure(
  key: string,
  failure: string,
  cache: Map<string, CachedGitHubSummary>,
  failedAt: number,
  previous = cache.get(key),
): GitHubPullRequestSummaryView {
  const next: CachedGitHubSummary = {
    ...(previous?.data ? { data: previous.data } : {}),
    ...(previous?.checkedAt !== undefined
      ? { checkedAt: previous.checkedAt }
      : {}),
    failure,
    failureAt: failedAt,
  };
  cache.set(key, next);
  return next.data && next.checkedAt !== undefined
    ? toGitHubSummaryView(next.data, next.checkedAt, 'stale', failure)
    : unavailableGitHubSummary(failure);
}

function toGitHubSummaryView(
  data: GitHubIssuePullRequestSummaries,
  checkedAt: number,
  overrideStatus?: 'stale',
  refreshFailure?: string,
): GitHubPullRequestSummaryView {
  const partial =
    data.pullRequestsTruncated ||
    data.pullRequests.some((pullRequest) => pullRequest.checksTruncated);
  const status = overrideStatus ?? (
    partial
      ? 'partial'
      : data.pullRequests.length > 0
        ? 'available'
        : 'none'
  );
  return {
    status,
    source: 'github_api',
    checkedAt,
    freshness: overrideStatus ? 'stale' : 'fresh',
    ...(partial ? { reason: 'github_result_truncated' } : {}),
    ...(refreshFailure ? { refreshFailure } : {}),
    items: data.pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      state: pullRequest.state,
      head: {
        ref: pullRequest.headRefName,
        sha: pullRequest.headRefOid,
      },
      review: {
        decision: pullRequest.reviewDecision,
        status: pullRequest.reviewDecision ? 'available' : 'unknown',
        source: 'github_api',
      },
      checks: {
        status: pullRequest.checksTruncated
          ? 'truncated'
          : pullRequest.checks.length > 0
            ? 'available'
            : 'none',
        source: 'github_api',
        items: pullRequest.checks,
      },
    })),
  };
}

function unavailableGitHubSummary(
  reason: string,
): GitHubPullRequestSummaryView {
  return {
    status: 'unavailable',
    source: null,
    checkedAt: null,
    freshness: 'not_observed',
    reason,
    items: [],
  };
}

function classifyGitHubFailure(error: unknown): string {
  if (isGitHubRateLimitError(error)) return 'rate_limited';
  if (isGitHubAuthError(error)) return 'authentication';
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return 'timeout';
  }
  if (error instanceof GitHubApiError) return 'github_api_error';
  return 'request_failed';
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
