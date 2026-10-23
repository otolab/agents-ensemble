import { resolve } from 'node:path';
import {
  listSessionResumeStores,
  harnessPhaseFromLegacyLifecycle,
  loadSessionStateStore,
  legacySessionStateStorePath,
  parseIssueUrl,
  sessionStateStorePath,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionLifecycle,
  type SessionStateStore,
  type SessionResumeStore,
  type HarnessPhase,
} from '@agents-ensemble/core/operator-runtime';
import type { OperatorSessionLiveStatus } from './operator-watch-pool.js';

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
  openQuestionCount: number;
  workers: string[];
  openQuestions: Array<{
    id: string;
    question: string;
    responseType: string;
    context?: string;
    relatedPermissionId?: string;
  }>;
  answeredQuestionCount: number;
}

type SessionSort = 'updatedAtDesc' | 'updatedAtAsc';

/** Build a read-only tool over this repository's saved conductor session data. */
export function createListOperatorSessionsTool(
  repoRoot: string,
  getLiveStatus?: (
    conductorAgentId: string,
  ) => OperatorSessionLiveStatus | undefined,
): ConductorTool {
  const root = resolve(repoRoot);
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
      const dataAsOf = new Date().toISOString();
      const resumeStores = await listSessionResumeStores(root);
      const snapshots = await Promise.all(
        resumeStores.map(async (resumeStore) => ({
          resumeStore,
          status: await loadStatusLine(root, resumeStore),
        })),
      );
      const filtered = snapshots.filter(({ resumeStore, status }) => {
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
        const direction = sort === 'updatedAtDesc' ? -1 : 1;
        return (
          direction * (left.resumeStore.updatedAt - right.resumeStore.updatedAt) ||
          left.resumeStore.conductorAgentId.localeCompare(
            right.resumeStore.conductorAgentId,
          )
        );
      });
      const sessions = filtered
        .slice(0, limit)
        .map(({ resumeStore, status }) =>
          summarizeSession(
            resumeStore,
            status,
            getLiveStatus?.(resumeStore.conductorAgentId),
          ),
        );
      const payload = {
        repoRoot: root,
        dataAsOf,
        total: filtered.length,
        returned: sessions.length,
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
  repoRoot: string,
  resumeStore: SessionResumeStore,
): Promise<SessionStateStore | undefined> {
  try {
    const input = {
      repoRoot,
      conductorAgentId: resumeStore.conductorAgentId,
    };
    return (
      (await loadSessionStateStore(sessionStateStorePath(input))) ??
      (await loadSessionStateStore(legacySessionStateStorePath(input)))
    );
  } catch {
    // Status reporting is an optional operator snapshot. A missing, partial, or
    // unsupported file must not hide an otherwise readable session.
    return undefined;
  }
}

function summarizeSession(
  resumeStore: SessionResumeStore,
  status: SessionStateStore | undefined,
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
  const openQuestions = resumeStore.openQuestions.filter(
    (question) => question.status === 'open',
  );
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
    openQuestionCount: openQuestions.length,
    workers: Object.keys(resumeStore.workers).sort(),
    openQuestions: openQuestions.map((question) => ({
      id: question.id,
      question: question.question,
      responseType: question.responseType,
      ...(question.context ? { context: question.context } : {}),
      ...(question.relatedPermissionId
        ? { relatedPermissionId: question.relatedPermissionId }
        : {}),
    })),
    answeredQuestionCount: resumeStore.openQuestions.filter(
      (question) => question.status === 'answered',
    ).length,
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
