import { describe, expect, it } from 'vitest';
import {
  ToolCallSnapshotRegistry,
  TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES,
  TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES,
  TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
} from './tool-call-snapshot-registry.js';

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

  it('rebinds persisted scopes to new runtime worker IDs without mixing sessions', () => {
    const beforeResume = new ToolCallSnapshotRegistry();
    beforeResume.apply(
      {
        workerId: 'old-worker-a',
        workerName: 'implementer',
        sessionId: 'acp-session-a',
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-reused',
        kind: 'edit',
        locations: [{ path: '/repo/a.ts' }],
      },
      10_000,
    );
    beforeResume.apply(
      {
        workerId: 'old-worker-b',
        workerName: 'reviewer',
        sessionId: 'acp-session-b',
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-reused',
        kind: 'shell',
        rawInput: { command: 'echo reviewer' },
      },
      11_000,
    );
    beforeResume.apply(
      {
        workerId: 'old-worker-a',
        workerName: 'implementer',
        sessionId: 'acp-session-c',
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-reused',
        kind: 'read',
        locations: [{ path: '/repo/c.ts' }],
      },
      11_500,
    );

    const afterResume = new ToolCallSnapshotRegistry();
    expect(
      afterResume.restore(
        beforeResume.snapshot(11_500),
        new Map([
          ['implementer', 'new-worker-a'],
          ['reviewer', 'new-worker-b'],
        ]),
        12_000,
      ),
    ).toEqual({ restoredCount: 3, skippedCount: 0 });

    expect(afterResume.findAll('call-reused', 12_000)).toEqual([
      {
        workerId: 'new-worker-a',
        workerName: 'implementer',
        sessionId: 'acp-session-a',
        snapshot: {
          toolCallId: 'call-reused',
          kind: 'edit',
          locations: [{ path: '/repo/a.ts' }],
        },
      },
      {
        workerId: 'new-worker-a',
        workerName: 'implementer',
        sessionId: 'acp-session-c',
        snapshot: {
          toolCallId: 'call-reused',
          kind: 'read',
          locations: [{ path: '/repo/c.ts' }],
        },
      },
      {
        workerId: 'new-worker-b',
        workerName: 'reviewer',
        sessionId: 'acp-session-b',
        snapshot: {
          toolCallId: 'call-reused',
          kind: 'shell',
          rawInput: { command: 'echo reviewer' },
        },
      },
    ]);
    expect(afterResume.get('call-reused', {
      workerId: 'new-worker-a',
      sessionId: 'acp-session-a',
    }, 12_000)).toMatchObject({ kind: 'edit' });
    expect(afterResume.get('call-reused', {
      workerId: 'new-worker-a',
      sessionId: 'acp-session-c',
    }, 12_000)).toMatchObject({ kind: 'read' });
  });

  it('expires old entries and declines a single snapshot larger than the file limit', () => {
    const registry = new ToolCallSnapshotRegistry();
    const oldTime = 1_000;
    registry.apply(
      { workerId: 'worker-a', workerName: 'implementer', sessionId: 'session-a' },
      { toolCallId: 'call-expired', kind: 'read' },
      oldTime,
    );
    registry.apply(
      { workerId: 'worker-a', workerName: 'implementer', sessionId: 'session-a' },
      {
        toolCallId: 'call-oversized',
        rawInput: { value: 'x'.repeat(TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES + 1) },
      },
      oldTime + TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS + 1,
    );

    expect(registry.get('call-expired', {
      workerId: 'worker-a',
      sessionId: 'session-a',
    }, oldTime + TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS + 1)).toBeUndefined();
    expect(registry.get('call-oversized', {
      workerId: 'worker-a',
      sessionId: 'session-a',
    }, oldTime + TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS + 1)).toBeUndefined();
  });

  it('evicts the oldest complete snapshot when the entry limit is reached', () => {
    const registry = new ToolCallSnapshotRegistry();
    const now = 20_000 + TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES;
    for (let index = 0; index <= TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES; index += 1) {
      registry.apply(
        {
          workerId: 'worker-a',
          workerName: 'implementer',
          sessionId: 'session-a',
        },
        { toolCallId: `call-${index}`, kind: 'read' },
        now - TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES + index,
      );
    }

    expect(registry.snapshot(now)).toHaveLength(
      TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES,
    );
    expect(registry.get('call-0', {
      workerId: 'worker-a',
      sessionId: 'session-a',
    }, now)).toBeUndefined();
    expect(registry.get(`call-${TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES}`, {
      workerId: 'worker-a',
      sessionId: 'session-a',
    }, now)).toBeDefined();
  });
});
