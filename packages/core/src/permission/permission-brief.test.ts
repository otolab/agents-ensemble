import { describe, expect, it } from 'vitest';
import { permissionRequestFixtures } from '../../test/fixtures/permission-request-fixtures.js';
import { parsePermissionRequest } from './permission-request.js';
import { buildPermissionBrief } from './permission-brief.js';

describe('buildPermissionBrief', () => {
  it('builds an Edit brief from permission params', () => {
    const request = parsePermissionRequest(
      permissionRequestFixtures.editCursorAcpV1.params,
    );

    expect(buildPermissionBrief(request)).toEqual({
      toolCallId: 'edit-cursor-1234567890',
      tool: 'Edit',
      operation: {
        kind: 'edit',
        path: '/workspace/agents-ensemble/packages/core/src/permission/format-permission-summary-for-operator.ts',
        line: 42,
      },
      missing: [],
    });
  });

  it('fills missing fields from the tool-call snapshot', () => {
    const request = parsePermissionRequest({
      sessionId: 'session-edit',
      toolCall: { toolCallId: 'call-edit-1' },
      options: [{ optionId: 'allow', kind: 'allow_once' }],
    });

    expect(
      buildPermissionBrief(request, {
        toolCallId: 'call-edit-1',
        kind: 'edit',
        title: 'Edit File',
        locations: [{ path: '/repo/src/example.ts', line: 12 }],
      }),
    ).toEqual({
      toolCallId: 'call-edit-1',
      tool: 'Edit',
      operation: {
        kind: 'edit',
        path: '/repo/src/example.ts',
        line: 12,
      },
      missing: [],
    });
  });

  it('keeps toolCallId-only requests incomplete', () => {
    const request = parsePermissionRequest(
      permissionRequestFixtures.executeIdOnly,
    );

    expect(buildPermissionBrief(request)).toEqual({
      toolCallId: 'exec-id-only-1',
      tool: 'Shell',
      operation: { kind: 'shell' },
      missing: ['cmd'],
    });
  });

  it('reports a missing detail for an unknown operation with no description', () => {
    const request = parsePermissionRequest({
      toolCall: { toolCallId: 'call-unknown-1' },
    });

    expect(buildPermissionBrief(request)).toEqual({
      toolCallId: 'call-unknown-1',
      tool: 'unknown',
      operation: { kind: 'other' },
      missing: ['detail'],
    });
  });

  it('gives permission params precedence over snapshot fields', () => {
    const request = parsePermissionRequest({
      toolName: 'Edit',
      toolCall: {
        toolCallId: 'call-edit-2',
        rawInput: { path: '/permission/request.ts' },
      },
    });

    expect(
      buildPermissionBrief(request, {
        toolCallId: 'call-edit-2',
        kind: 'edit',
        rawInput: { path: '/tool-call/update.ts' },
      }).operation.path,
    ).toBe('/permission/request.ts');
  });
});
