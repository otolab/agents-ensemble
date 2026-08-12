import { describe, expect, it } from 'vitest';
import { formatConductorToolName } from './conductor-tool-name.js';

describe('formatConductorToolName', () => {
  it('returns tool type for built-in tools', () => {
    expect(
      formatConductorToolName({
        type: 'shell',
        args: { command: 'echo hi' },
      } as never),
    ).toBe('shell');
  });

  it('formats MCP tools with provider and tool name', () => {
    expect(
      formatConductorToolName({
        type: 'mcp',
        args: {
          providerIdentifier: 'prompt_worker',
          toolName: 'dispatch',
        },
      } as never),
    ).toBe('mcp:prompt_worker/dispatch');
  });
});
