import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import type { ToolCallSnapshotRegistry } from '../runtime/tool-call-snapshot-registry.js';
import { yamlToolResult } from './yaml-tool-result.js';

export interface GetToolCallToolOptions {
  snapshots: ToolCallSnapshotRegistry;
}

/** Creates the conductor tool for retrieving a complete accumulated tool call. */
export function createGetToolCallTool(
  options: GetToolCallToolOptions,
): ConductorToolSet {
  return {
    get_tool_call: {
      name: 'get_tool_call',
      description:
        'Return accumulated tool call data and its worker / ACP session scope for a toolCallId.',
      inputSchema: {
        type: 'object',
        properties: {
          toolCallId: {
            type: 'string',
            description: 'ACP toolCallId from permission.pending',
          },
        },
        required: ['toolCallId'],
      },
      async execute(args) {
        const toolCallId = String(args.toolCallId ?? '').trim();
        if (!toolCallId) {
          throw new Error('get_tool_call requires toolCallId');
        }

        const matches = options.snapshots.findAll(toolCallId);
        const result =
          matches.length === 1
            ? {
                workerId: matches[0]!.workerId,
                sessionId: matches[0]!.sessionId,
                toolCall: matches[0]!.snapshot,
              }
            : matches.length === 0
              ? { found: false, toolCallId }
              : {
                  ambiguous: true,
                  toolCallId,
                  matches: matches.map(({ workerId, sessionId, snapshot }) => ({
                    workerId,
                    sessionId,
                    toolCall: snapshot,
                  })),
                };
        return yamlToolResult(
          'get_tool_call',
          result,
        );
      },
    },
  };
}
