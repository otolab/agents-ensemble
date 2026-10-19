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
        'Return the complete accumulated tool call for a toolCallId.',
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

        const snapshot = options.snapshots.get(toolCallId);
        return yamlToolResult(
          'get_tool_call',
          snapshot ?? { found: false, toolCallId },
        );
      },
    },
  };
}
