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

export function createSetSessionFocusTool(
  queue: OperatorDispatchQueue,
): ConductorTool {
  return {
    name: 'set_session_focus',
    description:
      'Set the session whose reports receive focus priority, or omit conductorAgentId to turn focus off. Focus defaults to off. While on, all reports from the focused session precede reports from other sessions, so an Open Question outside focus can wait. The operator should switch or clear focus when work changes and manually clear it when the focused session enters a human-response wait; the default 10-minute sliding timeout since operator/user input is a failsafe and is configurable from 3–30 minutes with common.scheduling.focusInactivityTimeoutMs or profiles.<name>.scheduling.focusInactivityTimeoutMs. Only operator/user input received by operator-agent resets the timeout; invoking this tool or receiving automatic reports does not.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (
        args.conductorAgentId !== undefined &&
        (typeof args.conductorAgentId !== 'string' ||
          args.conductorAgentId.trim().length === 0)
      ) {
        throw new Error('conductorAgentId must be a non-empty string when provided.');
      }
      queue.setFocus(
        typeof args.conductorAgentId === 'string'
          ? args.conductorAgentId
          : undefined,
      );
      return toolResult({
        focusSessionId: queue.focusSessionId ?? null,
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
