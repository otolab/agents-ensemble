import type { SDKCustomTool } from '@cursor/sdk';
import type { ConductorToolRegistry } from './conductor-tool.js';

/** SDK-shaped custom tools kept at the Cursor backend boundary. */
export type SdkCustomTools = Record<string, SDKCustomTool>;

export function toSdkCustomTools(
  registry: ConductorToolRegistry,
): SdkCustomTools {
  const tools: SdkCustomTools = {};
  for (const tool of registry.list()) {
    tools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: tool.execute,
    };
  }
  return tools;
}
