import { describe, expect, it } from 'vitest';
import { permissionRequestFixtures } from '../../test/fixtures/permission-request-fixtures.js';
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

  it('preserves well-formed ACP permission options', () => {
    const request = parsePermissionRequest({
      toolName: 'Shell',
      options: [
        { optionId: 'codex-allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'codex-reject', name: 'Reject', kind: 'reject_once' },
        { optionId: '', kind: 'allow_once' },
        { optionId: 'missing-kind' },
        'malformed',
      ],
    });

    expect(request.options).toEqual([
      { optionId: 'codex-allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'codex-reject', name: 'Reject', kind: 'reject_once' },
    ]);
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

  it.each([
    ['dogfooding execute payload', permissionRequestFixtures.dogfoodingExecute, 'Shell'],
    [
      'execute payload with JSON rawInput',
      permissionRequestFixtures.executeWithJsonRawInput,
      'Shell',
    ],
    ['read payload', permissionRequestFixtures.readPath, 'Read'],
    ['edit payload with snake_case fields', permissionRequestFixtures.editPath, 'Edit'],
    ['execute id-only payload', permissionRequestFixtures.executeIdOnly, 'Shell'],
  ])('infers tool name from %s', (_name, payload, expectedTool) => {
    expect(parsePermissionRequest(payload).toolName).toBe(expectedTool);
  });

  it('does not keep an explicit unknown tool when ACP metadata identifies it', () => {
    expect(
      parsePermissionRequest({
        toolName: 'unknown',
        ...permissionRequestFixtures.dogfoodingExecute,
      }).toolName,
    ).toBe('Shell');
  });
});

describe('ACP permission request fixtures', () => {
  it.each([
    [permissionRequestFixtures.dogfoodingExecute, { field: 'cmd', value: 'pnpm test' }],
    [
      permissionRequestFixtures.executeWithJsonRawInput,
      { field: 'cmd', value: 'pnpm test --filter=core' },
    ],
    [
      permissionRequestFixtures.readPath,
      { field: 'path', value: 'packages/core/src/index.ts' },
    ],
    [
      permissionRequestFixtures.editPath,
      { field: 'path', value: 'packages/cli/src/session-log-lines.ts' },
    ],
    [
      permissionRequestFixtures.executeIdOnly,
      { field: 'toolCallId', value: 'exec-id-only-1' },
    ],
  ])('extracts a readable operation summary from %j', (payload, expected) => {
    expect(
      extractPermissionOperationSummary(parsePermissionRequest(payload)),
    ).toEqual(expected);
  });

  it('prefers a command over toolCallId and raw JSON fallback', () => {
    const request = parsePermissionRequest(permissionRequestFixtures.dogfoodingExecute);

    expect(extractPermissionOperationSummary(request)).toEqual({
      field: 'cmd',
      value: 'pnpm test',
    });
    expect(formatPermissionSummaryForOperator({
      id: '4bf9479c-7f7f-4f1f-8a08-123456789abc',
      workerId: 'worker-uuid',
      createdAt: 0,
      request,
    }, { workerLabel: 'implementer' })).toBe(
      'permission.pending worker=implementer tool=Shell cmd="pnpm test" id=4bf9479c...',
    );
  });
});
