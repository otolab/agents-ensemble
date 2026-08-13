import { describe, expect, it } from 'vitest';
import { extractAcpToolName } from './extract-acp-tool-name.js';

describe('extractAcpToolName', () => {
  it('reads toolCall.name', () => {
    expect(
      extractAcpToolName({
        sessionUpdate: 'tool_call',
        toolCall: { name: 'Shell' },
      }),
    ).toBe('Shell');
  });

  it('reads top-level toolName', () => {
    expect(
      extractAcpToolName({
        sessionUpdate: 'tool_call',
        toolName: 'Edit',
      }),
    ).toBe('Edit');
  });

  it('returns undefined when no tool metadata', () => {
    expect(
      extractAcpToolName({
        sessionUpdate: 'agent_thought_chunk',
      }),
    ).toBeUndefined();
  });
});
