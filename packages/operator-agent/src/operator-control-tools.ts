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
      'Enable or disable the manual hold for automatic reports from watched Issue sessions. This hold composes with the automatic conversation hold. User TTY messages and explicit send_operator_message calls continue immediately.',
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
        reportHold: queue.reportHold,
        conversationHold: queue.conversationHold,
        effectiveHold: queue.hold,
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
      'Disable the manual report hold. Reports remain held while the automatic conversation hold is active. User messages remain highest priority.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const result = queue.setHold(false);
      return toolResult({
        hold: false,
        reportHold: queue.reportHold,
        conversationHold: queue.conversationHold,
        effectiveHold: queue.hold,
        releasedEventCount: result.releasedEventCount,
        heldEventCount: queue.heldEventCount,
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
