import { resolve } from 'node:path';
import {
  listSessionResumeStates,
  loadSessionStateStore,
  parseIssueUrl,
  sessionStateStorePath,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionLifecycle,
  type SessionStateStore,
  type SessionResumeState,
} from '@agents-ensemble/core/operator-runtime';

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
export function createListOperatorSessionsTool(repoRoot: string): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: LIST_OPERATOR_SESSIONS_TOOL,
    description:
      'Read saved SessionResumeStore records and session state under <repoRoot>/.ensemble/sessions. The results are snapshots, not live process status.',
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
      const resumeStates = await listSessionResumeStates(root);
      const snapshots = await Promise.all(
        resumeStates.map(async (resumeState) => ({
          resumeState,
          status: await loadStatusLine(root, resumeState),
        })),
      );
      const filtered = snapshots.filter(({ resumeState, status }) => {
        if (
          hasStatusLine !== undefined &&
          Boolean(status) !== hasStatusLine
        ) {
          return false;
        }
        const sessionLifecycle = resumeState.lifecycle ?? 'unknown';
        return lifecycle === undefined || sessionLifecycle === lifecycle;
      });
      filtered.sort((left, right) => {
        const direction = sort === 'updatedAtDesc' ? -1 : 1;
        return (
          direction * (left.resumeState.updatedAt - right.resumeState.updatedAt) ||
          left.resumeState.conductorAgentId.localeCompare(
            right.resumeState.conductorAgentId,
          )
        );
      });
      const sessions = filtered
        .slice(0, limit)
        .map(({ resumeState, status }) => summarizeSession(resumeState, status));
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
  resumeState: SessionResumeState,
): Promise<SessionStateStore | undefined> {
  try {
    return await loadSessionStateStore(
      sessionStateStorePath({
        repoRoot,
        conductorAgentId: resumeState.conductorAgentId,
      }),
    );
  } catch {
    // Status reporting is an optional operator snapshot. A missing, partial, or
    // unsupported file must not hide an otherwise readable session.
    return undefined;
  }
}

function summarizeSession(
  resumeState: SessionResumeState,
  status: SessionStateStore | undefined,
): OperatorSessionSummary {
  let issueRef: OperatorSessionSummary['issueRef'] = null;
  try {
    const parsed = parseIssueUrl(resumeState.issueUrl);
    issueRef = {
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
    };
  } catch {
    // Keep the original issueUrl visible for legacy or externally produced data.
  }
  const openQuestions = resumeState.openQuestions.filter(
    (question) => question.status === 'open',
  );

  return {
    agentId: resumeState.conductorAgentId,
    conductorAgentId: resumeState.conductorAgentId,
    issueRef,
    issueUrl: resumeState.issueUrl,
    conductorBackend: resumeState.conductorBackend ?? 'cursor',
    profile:
      resumeState.profile.meta?.title ??
      resumeState.profilePath ??
      'unknown',
    updatedAt: resumeState.updatedAt,
    statusLine: status?.current.statusLine ?? null,
    reportedAt: status?.current.reportedAt ?? null,
    statusLineHistory: status?.history ?? [],
    lifecycle: resumeState.lifecycle ?? 'unknown',
    liveControlPathRecorded: Boolean(resumeState.harnessSocketPath),
    openQuestionCount: openQuestions.length,
    workers: Object.keys(resumeState.workers).sort(),
    openQuestions: openQuestions.map((question) => ({
      id: question.id,
      question: question.question,
      responseType: question.responseType,
      ...(question.context ? { context: question.context } : {}),
      ...(question.relatedPermissionId
        ? { relatedPermissionId: question.relatedPermissionId }
        : {}),
    })),
    answeredQuestionCount: resumeState.openQuestions.filter(
      (question) => question.status === 'answered',
    ).length,
  };
}
