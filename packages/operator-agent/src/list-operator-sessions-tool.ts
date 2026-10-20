import { resolve } from 'node:path';
import {
  listSessionSidecars,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionSidecar,
} from '@agents-ensemble/core/operator-runtime';

export const LIST_OPERATOR_SESSIONS_TOOL = 'list_operator_sessions';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface OperatorSessionSummary {
  agentId: string;
  issueUrl: string;
  conductorBackend: string;
  profile: string;
  updatedAt: number;
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

/** Build a read-only tool over this repository's existing conductor sidecars. */
export function createListOperatorSessionsTool(repoRoot: string): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: LIST_OPERATOR_SESSIONS_TOOL,
    description:
      'Read saved conductor session sidecars under <repoRoot>/.ensemble/sessions and return a concise summary.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum number of recent sessions to return (default ${DEFAULT_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const limit = resolveLimit(args.limit);
      const sidecars = await listSessionSidecars(root);
      sidecars.sort((left, right) => right.updatedAt - left.updatedAt);
      const sessions = sidecars
        .slice(0, limit)
        .map(summarizeSession);
      const payload = {
        repoRoot: root,
        total: sidecars.length,
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

function summarizeSession(sidecar: SessionSidecar): OperatorSessionSummary {
  return {
    agentId: sidecar.conductorAgentId,
    issueUrl: sidecar.issueUrl,
    conductorBackend: sidecar.conductorBackend ?? 'cursor',
    profile:
      sidecar.profile.meta?.title ??
      sidecar.profilePath ??
      'unknown',
    updatedAt: sidecar.updatedAt,
    workers: Object.keys(sidecar.workers).sort(),
    openQuestions: sidecar.openQuestions
      .filter((question) => question.status === 'open')
      .map((question) => ({
        id: question.id,
        question: question.question,
        responseType: question.responseType,
        ...(question.context ? { context: question.context } : {}),
        ...(question.relatedPermissionId
          ? { relatedPermissionId: question.relatedPermissionId }
          : {}),
      })),
    answeredQuestionCount: sidecar.openQuestions.filter(
      (question) => question.status === 'answered',
    ).length,
  };
}
