import type { ToolCall } from '@cursor/sdk';

/** harness 向け conductor ツール名（`conductor.send.progress` 用）。 */
export function formatConductorToolName(toolCall: ToolCall): string {
  if (toolCall.type === 'mcp') {
    const provider = toolCall.args.providerIdentifier ?? 'unknown';
    const tool = toolCall.args.toolName ?? 'unknown';
    return `mcp:${provider}/${tool}`;
  }
  return toolCall.type;
}
