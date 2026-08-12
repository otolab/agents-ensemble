import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import yaml from 'js-yaml';
import type { SessionUsageTracker } from '../usage/session-usage-tracker.js';
import type { SessionUsageRound } from '../usage/types.js';

export interface SessionUsageToolOptions {
  tracker: SessionUsageTracker;
  workerNames: string[];
}

export function createSessionUsageTools(
  options: SessionUsageToolOptions,
): Record<string, SDKCustomTool> {
  const agentEnum = ['conductor', ...options.workerNames];

  return {
    get_session_usage: {
      description:
        'Read session-wide LLM token usage (cumulative input/output, per-agent breakdown, context utilization when limit is known). Use for operator token / context % questions — not prompt_worker.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute() {
        return yamlToolResult('get_session_usage', options.tracker.getSessionSummary());
      },
    },
    get_usage: {
      description:
        'Read the latest LLM usage round for conductor or a named worker. Use after get_session_usage when you need one round in detail.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: agentEnum,
            description:
              'conductor or profile worker name (e.g. implementer). Omit for the latest round of any agent.',
          },
        },
      },
      async execute(args) {
        const agent = args.agent != null ? String(args.agent).trim() : '';
        const round = options.tracker.getLatestRound(
          agent.length > 0 ? { agent } : undefined,
        );
        if (!round) {
          throw new Error('get_usage: no usage rounds recorded yet');
        }
        return yamlToolResult('get_usage', formatUsageRound(round));
      },
    },
  };
}

function formatUsageRound(round: SessionUsageRound) {
  return {
    roundId: round.roundId,
    agentKind: round.agentKind,
    agentName: round.agentName ?? null,
    workerKind: round.workerKind ?? null,
    source: round.source ?? null,
    runId: round.runId ?? null,
    modelId: round.modelId ?? null,
    stopReason: round.stopReason ?? null,
    usage: round.usage,
    recordedAt: round.recordedAt,
  };
}

function yamlToolResult(label: string, data: unknown) {
  const text = [
    '```yaml',
    `# ${label}`,
    yaml.dump(data, { lineWidth: 120 }).trimEnd(),
    '```',
  ].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: toStructuredContent(data),
  };
}

function toStructuredContent(data: unknown): Record<string, SDKJsonValue> {
  return JSON.parse(JSON.stringify(data)) as Record<string, SDKJsonValue>;
}
