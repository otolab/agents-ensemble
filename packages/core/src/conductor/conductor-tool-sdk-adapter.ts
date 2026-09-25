import type { SDKCustomTool } from '@cursor/sdk';
import {
  ConductorToolRegistry,
  type ConductorToolSet,
} from './conductor-tool.js';

/** SDK-shaped custom tools kept at the Cursor backend boundary. */
export type SdkCustomTools = Record<string, SDKCustomTool>;

export function toSdkCustomTools(
  toolSet: ConductorToolRegistry | ConductorToolSet,
): SdkCustomTools {
  const tools: SdkCustomTools = {};
  const entries =
    toolSet instanceof ConductorToolRegistry
      ? toolSet.list()
      : Object.values(toolSet);
  for (const tool of entries) {
    tools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: tool.execute,
    };
  }
  return tools;
}
