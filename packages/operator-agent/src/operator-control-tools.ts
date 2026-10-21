import {
  type ConductorJsonValue,
  type ConductorTool,
} from '@agents-ensemble/core/operator-runtime';
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

function toolResult(value: Record<string, ConductorJsonValue>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
