import type {
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  ConductorToolRegistry,
  type ConductorJsonValue,
  type ConductorToolSet,
} from './conductor-tool.js';

/**
 * Convert backend-neutral tools to the Pi 1.x AgentSession SDK shape.
 *
 * AgentSession owns tool registration and execution hooks. Keep this adapter
 * separate from the low-level AgentTool adapter so callers cannot accidentally
 * bypass the SDK session path.
 */
export function toPiCodingAgentTools(
  toolSet: ConductorToolRegistry | ConductorToolSet,
): ToolDefinition[] {
  const entries =
    toolSet instanceof ConductorToolRegistry
      ? toolSet.list()
      : Object.values(toolSet);

  return entries.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as ToolDefinition['parameters'],
    execute: async (_toolCallId, args) => {
      const result = await tool.execute(
        args as Record<string, ConductorJsonValue>,
      );
      return {
        content: result.content,
        details: result.structuredContent ?? {},
      };
    },
  }));
}
