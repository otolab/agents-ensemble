import { describe, expect, it } from 'vitest';
import { ToolCallSnapshotRegistry } from './tool-call-snapshot-registry.js';

describe('ToolCallSnapshotRegistry', () => {
  it('accumulates partial tool_call updates by toolCallId', () => {
    const registry = new ToolCallSnapshotRegistry();
    registry.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-1',
      kind: 'edit',
      title: 'Edit File',
      status: 'pending',
      rawInput: { oldString: 'before', newString: 'after' },
    });
    registry.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-1',
      status: 'in_progress',
      locations: [{ path: '/repo/src/example.ts', line: 12 }],
      rawInput: null,
    });

    expect(registry.get('call-edit-1')).toEqual({
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
    registry.apply({
      sessionUpdate: 'tool_call',
      toolCall: {
        toolCallId: 'call-read-1',
        kind: 'read',
        title: 'Read File',
      },
    });
    registry.apply({
      sessionUpdate: 'tool_call_update',
      tool_call_id: 'call-other-1',
      status: 'completed',
    });

    expect(registry.get('call-read-1')).toEqual({
      toolCallId: 'call-read-1',
      kind: 'read',
      title: 'Read File',
    });
    expect(registry.get('call-other-1')).toEqual({
      tool_call_id: 'call-other-1',
      toolCallId: 'call-other-1',
      status: 'completed',
    });
    expect(registry.get('call-missing')).toBeUndefined();
  });

  it('ignores updates without a toolCallId', () => {
    const registry = new ToolCallSnapshotRegistry();
    registry.apply({ sessionUpdate: 'tool_call', kind: 'edit' });

    expect(registry.get('')).toBeUndefined();
  });
});
