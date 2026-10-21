import {
  listSessionSidecars,
  OPEN_QUESTION_CONTROL_METHODS,
  sendOpenQuestionControlRequest,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionSidecar,
} from '@agents-ensemble/core/operator-runtime';
import { resolve } from 'node:path';
import type { OperatorDispatchQueue } from './operator-dispatch.js';

export function createSetReportHoldTool(
  queue: OperatorDispatchQueue,
): ConductorTool {
  return {
    name: 'set_report_hold',
    description:
      'Hold or resume automatic reports from watched Issue sessions. User TTY messages and explicit send_operator_message calls continue immediately.',
    inputSchema: {
      type: 'object',
      properties: { hold: { type: 'boolean' } },
      required: ['hold'],
      additionalProperties: false,
    },
    execute: async (args) => {
      if (typeof args.hold !== 'boolean') {
        throw new Error('hold must be a boolean.');
      }
      const result = queue.setHold(args.hold);
      return toolResult({
        hold: args.hold,
        heldEventCount: result.heldEventCount,
        releasedEventCount: result.releasedEventCount,
      });
    },
  };
}

export function createReleaseReportsTool(
  queue: OperatorDispatchQueue,
): ConductorTool {
  return {
    name: 'release_reports',
    description:
      'Release all held watched-session reports into the operator dispatch queue. User messages remain highest priority.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const result = queue.setHold(false);
      return toolResult({
        hold: false,
        releasedEventCount: result.releasedEventCount,
        pendingEventCount: queue.pendingEventCount,
      });
    },
  };
}

export function createSendOperatorMessageTool(repoRoot: string): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: 'send_operator_message',
    description:
      'Send an explicit operator message to a running Issue harness. Delivery defaults to next, matching #525. This direct operator.message path bypasses report hold; do not retry automatically if the outcome is unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        text: { type: 'string' },
        delivery: {
          type: 'string',
          enum: ['next'],
          description: 'Delivery mode (default next).',
        },
      },
      required: ['conductorAgentId', 'text'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const text = requireString(args.text, 'text');
      if (args.delivery !== undefined && args.delivery !== 'next') {
        throw new Error('delivery must be next.');
      }
      const sidecar = await requireSession(root, conductorAgentId);
      if (!sidecar.harnessSocketPath) {
        throw new Error(
          `Session ${conductorAgentId} has no recorded live control socket.`,
        );
      }
      const result = await sendOpenQuestionControlRequest<{
        accepted: boolean;
        delivery: 'next';
      }>(sidecar.harnessSocketPath, {
        method: OPEN_QUESTION_CONTROL_METHODS.operatorMessage,
        params: { text, delivery: args.delivery ?? 'next' },
      });
      return toolResult({ conductorAgentId, ...result });
    },
  };
}

async function requireSession(
  repoRoot: string,
  conductorAgentId: string,
): Promise<SessionSidecar> {
  const sidecar = (await listSessionSidecars(repoRoot)).find(
    (candidate) => candidate.conductorAgentId === conductorAgentId,
  );
  if (!sidecar) throw new Error(`No saved session found for ${conductorAgentId}.`);
  return sidecar;
}

function requireString(
  value: ConductorJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function toolResult(value: Record<string, ConductorJsonValue>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
