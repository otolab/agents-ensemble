import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import { yamlToolResult } from './yaml-tool-result.js';

export const REPORT_SESSION_STATE_MAX_LENGTH = 80;

export function createReportSessionStateTool(options?: {
  onReport?: (statusLine: string) => Promise<void>;
}): ConductorToolSet {
  return {
    report_session_state: {
      name: 'report_session_state',
      description:
        'Register a one-line operator status (max 80 characters). Omit metrics and worker or permission details.',
      inputSchema: {
        type: 'object',
        properties: {
          statusLine: {
            type: 'string',
            maxLength: REPORT_SESSION_STATE_MAX_LENGTH,
            description: 'A concise, one-line status for the operator.',
          },
        },
        required: ['statusLine'],
      },
      async execute(args) {
        if (typeof args.statusLine !== 'string') {
          throw new Error('report_session_state requires statusLine');
        }

        const statusLine = args.statusLine.trim();
        if (!statusLine) {
          throw new Error('report_session_state statusLine must not be empty');
        }
        if (/[\r\n]/u.test(statusLine)) {
          throw new Error('report_session_state statusLine must be one line');
        }
        if (Array.from(statusLine).length > REPORT_SESSION_STATE_MAX_LENGTH) {
          throw new Error(
            `report_session_state statusLine must be at most ${REPORT_SESSION_STATE_MAX_LENGTH} characters`,
          );
        }

        await options?.onReport?.(statusLine);
        return yamlToolResult('report_session_state', { statusLine });
      },
    },
  };
}
