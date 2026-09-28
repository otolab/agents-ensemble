import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  ConductorToolRegistry,
  type ConductorJsonValue,
  type ConductorToolSet,
} from './conductor-tool.js';

/** Pi-shaped harness tools kept at the Pi backend boundary. */
export type PiAgentTool = AgentTool;

/**
 * Convert backend-neutral harness tools to Pi AgentTools.
 *
 * The conductor only receives the tools supplied by the harness. Pi's coding
 * tools are deliberately not added here; worker ACP sessions remain the place
 * where repository operations happen.
 */
export function toPiAgentTools(
  toolSet: ConductorToolRegistry | ConductorToolSet,
): PiAgentTool[] {
  const entries =
    toolSet instanceof ConductorToolRegistry
      ? toolSet.list()
      : Object.values(toolSet);

  return entries.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // ConductorTool uses the same JSON-Schema representation as Pi's
    // TypeBox-compatible parameters. Keep the cast at this adapter boundary
    // rather than making the backend-neutral type depend on Pi.
    parameters: tool.inputSchema as AgentTool['parameters'],
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
