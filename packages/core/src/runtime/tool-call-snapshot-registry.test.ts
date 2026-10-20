import { describe, expect, it } from 'vitest';
import { ToolCallSnapshotRegistry } from './tool-call-snapshot-registry.js';

describe('ToolCallSnapshotRegistry', () => {
  it('accumulates partial tool_call updates by toolCallId', () => {
    const registry = new ToolCallSnapshotRegistry();
    const scope = { workerId: 'worker-a', sessionId: 'session-a' };
    registry.apply(scope, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-1',
      kind: 'edit',
      title: 'Edit File',
      status: 'pending',
      rawInput: { oldString: 'before', newString: 'after' },
    });
    registry.apply(scope, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-1',
      status: 'in_progress',
      locations: [{ path: '/repo/src/example.ts', line: 12 }],
      rawInput: null,
    });

    expect(registry.get('call-edit-1', scope)).toEqual({
      toolCallId: 'call-edit-1',
      kind: 'edit',
      title: 'Edit File',
      status: 'in_progress',
      rawInput: { oldString: 'before', newString: 'after' },
      locations: [{ path: '/repo/src/example.ts', line: 12 }],
    });
  });

  it('accepts nested toolCall payloads and keeps identifiers isolated', () => {
    const registry = new ToolCallSnapshotRegistry();
    const scope = { workerId: 'worker-a', sessionId: 'session-a' };
    registry.apply(scope, {
      sessionUpdate: 'tool_call',
      toolCall: {
        toolCallId: 'call-read-1',
        kind: 'read',
        title: 'Read File',
      },
    });
    registry.apply(scope, {
      sessionUpdate: 'tool_call_update',
      tool_call_id: 'call-other-1',
      status: 'completed',
    });

    expect(registry.get('call-read-1', scope)).toEqual({
      toolCallId: 'call-read-1',
      kind: 'read',
      title: 'Read File',
    });
    expect(registry.get('call-other-1', scope)).toEqual({
      tool_call_id: 'call-other-1',
      toolCallId: 'call-other-1',
      status: 'completed',
    });
    expect(registry.get('call-missing', scope)).toBeUndefined();
  });

  it('ignores updates without a toolCallId', () => {
    const registry = new ToolCallSnapshotRegistry();
    registry.apply(
      { workerId: 'worker-a', sessionId: 'session-a' },
      { sessionUpdate: 'tool_call', kind: 'edit' },
    );

    expect(registry.get('', { workerId: 'worker-a', sessionId: 'session-a' }))
      .toBeUndefined();
    registry.apply(
      { workerId: 'worker-a', sessionId: '' },
      { sessionUpdate: 'tool_call', toolCallId: 'call-no-session' },
    );
    expect(registry.findAll('call-no-session')).toEqual([]);
  });

  it('keeps reused toolCallIds isolated across ACP sessions', () => {
    const registry = new ToolCallSnapshotRegistry();
    const firstScope = { workerId: 'worker-a', sessionId: 'session-a' };
    const secondScope = { workerId: 'worker-a', sessionId: 'session-b' };

    registry.apply(firstScope, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-reused',
      kind: 'edit',
      locations: [{ path: '/workspace/worker-a.ts' }],
    });
    registry.apply(secondScope, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-reused',
      kind: 'shell',
      rawInput: { command: 'rm -rf /workspace/worker-b' },
    });

    expect(registry.get('call-reused', firstScope)).toEqual({
      toolCallId: 'call-reused',
      kind: 'edit',
      locations: [{ path: '/workspace/worker-a.ts' }],
    });
    expect(registry.get('call-reused', secondScope)).toEqual({
      toolCallId: 'call-reused',
      kind: 'shell',
      rawInput: { command: 'rm -rf /workspace/worker-b' },
    });
    expect(registry.findAll('call-reused')).toEqual([
      {
        ...firstScope,
        snapshot: {
          toolCallId: 'call-reused',
          kind: 'edit',
          locations: [{ path: '/workspace/worker-a.ts' }],
        },
      },
      {
        ...secondScope,
        snapshot: {
          toolCallId: 'call-reused',
          kind: 'shell',
          rawInput: { command: 'rm -rf /workspace/worker-b' },
        },
      },
    ]);
  });
});
