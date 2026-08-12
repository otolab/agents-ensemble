import { describe, expect, it } from 'vitest';
import {
  extractPermissionOperationSummary,
  formatPermissionSummaryForOperator,
} from './format-permission-summary-for-operator.js';
import type { PendingPermission } from './pending-permission.js';
import { parsePermissionRequest } from './permission-request.js';

describe('parsePermissionRequest', () => {
  it('reads top-level toolName', () => {
    expect(parsePermissionRequest({ toolName: 'Shell' }).toolName).toBe('Shell');
  });

  it('reads tool name from ACP toolCall (shell)', () => {
    const request = parsePermissionRequest({
      sessionId: 'sess-1',
      toolCall: {
        type: 'shell',
        args: { command: 'npm test --filter=core' },
      },
    });

    expect(request.toolName).toBe('shell');
    expect(request.sessionId).toBe('sess-1');
    expect(extractPermissionOperationSummary(request)).toEqual({
      field: 'cmd',
      value: 'npm test --filter=core',
    });
  });

  it('reads tool name from ACP toolCall (write)', () => {
    const request = parsePermissionRequest({
      toolCall: {
        type: 'write',
        args: { path: '/tmp/example.ts', contents: 'hello' },
      },
    });

    expect(request.toolName).toBe('write');
    expect(extractPermissionOperationSummary(request)).toEqual({
      field: 'path',
      value: '/tmp/example.ts',
    });
  });

  it('formats toolCall permission summary for operator', () => {
    const pending: PendingPermission = {
      id: 'perm-3',
      workerId: 'worker-uuid',
      createdAt: 0,
      request: parsePermissionRequest({
        toolCall: {
          type: 'shell',
          args: { command: 'npm test' },
        },
      }),
    };

    expect(
      formatPermissionSummaryForOperator(pending, { workerLabel: 'implementer' }),
    ).toBe(
      'permission.pending worker=implementer tool=shell cmd="npm test" id=perm-3',
    );
  });

  it('prefers explicit toolName over toolCall', () => {
    expect(
      parsePermissionRequest({
        toolName: 'Shell',
        toolCall: { type: 'shell', args: { command: 'ls' } },
      }).toolName,
    ).toBe('Shell');
  });

  it('formats MCP toolCall names', () => {
    expect(
      parsePermissionRequest({
        toolCall: {
          type: 'mcp',
          args: {
            providerIdentifier: 'prompt_worker',
            toolName: 'dispatch',
          },
        },
      }).toolName,
    ).toBe('mcp:prompt_worker/dispatch');
  });
});
