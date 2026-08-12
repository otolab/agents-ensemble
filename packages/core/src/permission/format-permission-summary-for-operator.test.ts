import { describe, expect, it } from 'vitest';
import {
  extractPermissionOperationSummary,
  formatPermissionSummaryForOperator,
} from './format-permission-summary-for-operator.js';
import type { PendingPermission } from './pending-permission.js';
import { parsePermissionRequest } from './permission-request.js';

function pending(
  overrides: Partial<PendingPermission> & Pick<PendingPermission, 'id' | 'request'>,
): PendingPermission {
  return {
    workerId: 'worker-uuid-1234',
    createdAt: 0,
    ...overrides,
  };
}

describe('formatPermissionSummaryForOperator', () => {
  it('formats Shell permission with worker kind and command', () => {
    const summary = formatPermissionSummaryForOperator(
      pending({
        id: 'perm-3',
        request: parsePermissionRequest({
          toolName: 'Shell',
          input: { command: 'npm test --filter=core' },
        }),
      }),
      { workerLabel: 'implementer' },
    );

    expect(summary).toBe(
      'permission.pending worker=implementer tool=Shell cmd="npm test --filter=core" id=perm-3',
    );
  });

  it('formats Write permission with path', () => {
    const summary = formatPermissionSummaryForOperator(
      pending({
        id: 'abc-def-ghi-jkl',
        request: parsePermissionRequest({
          toolName: 'Write',
          path: '/tmp/example.ts',
        }),
      }),
      { workerLabel: 'implementer' },
    );

    expect(summary).toContain('tool=Write');
    expect(summary).toContain('path=/tmp/example.ts');
    expect(summary).toContain('id=abc-def-...');
  });

  it('falls back to workerId and raw detail for unknown tools', () => {
    const summary = formatPermissionSummaryForOperator(
      pending({
        id: 'perm-1',
        workerId: 'worker-uuid',
        request: parsePermissionRequest({
          toolName: 'CustomTool',
          note: 'do something\nwith newline',
        }),
      }),
    );

    expect(summary).toContain('worker=worker-uuid');
    expect(summary).toContain('tool=CustomTool');
    expect(summary).toContain('detail=');
    expect(summary).not.toContain('\n');
  });
});

describe('extractPermissionOperationSummary', () => {
  it('reads Shell command from nested input', () => {
    expect(
      extractPermissionOperationSummary(
        parsePermissionRequest({
          toolName: 'Shell',
          input: { command: 'git status' },
        }),
      ),
    ).toEqual({ field: 'cmd', value: 'git status' });
  });

  it('reads Write path from top-level params', () => {
    expect(
      extractPermissionOperationSummary(
        parsePermissionRequest({
          toolName: 'Write',
          path: 'packages/core/src/index.ts',
        }),
      ),
    ).toEqual({ field: 'path', value: 'packages/core/src/index.ts' });
  });
});
