import type { ToolCall } from '@cursor/sdk';
import { describe, expect, it } from 'vitest';
import { formatConductorToolName } from './conductor-tool-name.js';

describe('formatConductorToolName', () => {
  it('returns tool type for built-in tools', () => {
    const toolCall = {
      type: 'shell',
      args: { command: 'echo hi' },
    } satisfies ToolCall;

    expect(formatConductorToolName(toolCall)).toBe('shell');
  });

  it('formats MCP tools with provider and tool name', () => {
    const toolCall = {
      type: 'mcp',
      args: {
        providerIdentifier: 'prompt_worker',
        toolName: 'dispatch',
      },
    } satisfies ToolCall;

    expect(formatConductorToolName(toolCall)).toBe('mcp:prompt_worker/dispatch');
  });
});
