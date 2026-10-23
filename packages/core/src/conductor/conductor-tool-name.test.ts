import { describe, expect, it } from 'vitest';
import { formatPermissionSummaryForOperator } from '../permission/format-permission-summary-for-operator.js';
import { parsePermissionRequest } from '../permission/permission-request.js';
import { formatConductorToolName } from './conductor-tool-name.js';

describe('formatConductorToolName', () => {
  it('returns tool type for built-in tools', () => {
    expect(
      formatConductorToolName({
        type: 'shell',
        args: { command: 'echo hi' },
      }),
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
      }),
    ).toBe('mcp:prompt_worker/dispatch');
  });

  it('shows the formatted MCP name in the operator permission summary', () => {
    const request = parsePermissionRequest({
      toolCall: {
        type: 'mcp',
        args: {
          providerIdentifier: 'prompt_worker',
          toolName: 'dispatch',
        },
      },
    });
    const summary = formatPermissionSummaryForOperator(
      {
        id: 'permission-mcp-tool-1',
        workerId: 'worker-uuid',
        createdAt: 0,
        request,
      },
      { workerLabel: 'implementer' },
    );

    expect(summary).toContain('tool=mcp:prompt_worker/dispatch');
  });
});
