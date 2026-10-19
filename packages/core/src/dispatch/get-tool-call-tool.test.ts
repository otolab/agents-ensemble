import { describe, expect, it } from 'vitest';
import { ToolCallSnapshotRegistry } from '../runtime/tool-call-snapshot-registry.js';
import { createGetToolCallTool } from './get-tool-call-tool.js';

describe('createGetToolCallTool', () => {
  it('returns the complete accumulated tool call', async () => {
    const snapshots = new ToolCallSnapshotRegistry();
    snapshots.apply({ workerId: 'worker-a', sessionId: 'session-a' }, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-1',
      kind: 'edit',
      title: 'Edit File',
      rawInput: { newString: 'updated' },
    });
    snapshots.apply({ workerId: 'worker-a', sessionId: 'session-a' }, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-1',
      locations: [{ path: '/repo/src/example.ts' }],
    });
    const tool = createGetToolCallTool({ snapshots }).get_tool_call!;

    const result = await tool.execute({ toolCallId: 'call-edit-1' });

    expect(result.structuredContent).toEqual({
      workerId: 'worker-a',
      sessionId: 'session-a',
      toolCall: {
        toolCallId: 'call-edit-1',
        kind: 'edit',
        title: 'Edit File',
        rawInput: { newString: 'updated' },
        locations: [{ path: '/repo/src/example.ts' }],
      },
    });
    expect(result.content[0]?.text).toContain('title: Edit File');
    expect(result.content[0]?.text).toContain('/repo/src/example.ts');
  });

  it('reports a missing snapshot without claiming it was found', async () => {
    const tool = createGetToolCallTool({
      snapshots: new ToolCallSnapshotRegistry(),
    }).get_tool_call!;

    const result = await tool.execute({ toolCallId: 'call-missing' });

    expect(result.structuredContent).toEqual({
      found: false,
      toolCallId: 'call-missing',
    });
  });

  it('returns colliding toolCallIds as separately scoped candidates', async () => {
    const snapshots = new ToolCallSnapshotRegistry();
    snapshots.apply(
      { workerId: 'worker-a', sessionId: 'session-a' },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-reused',
        kind: 'edit',
        locations: [{ path: '/workspace/a.ts' }],
      },
    );
    snapshots.apply(
      { workerId: 'worker-b', sessionId: 'session-b' },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-reused',
        kind: 'shell',
        rawInput: { command: 'echo worker-b' },
      },
    );
    const tool = createGetToolCallTool({ snapshots }).get_tool_call!;

    const result = await tool.execute({ toolCallId: 'call-reused' });

    expect(result.structuredContent).toEqual({
      ambiguous: true,
      toolCallId: 'call-reused',
      matches: [
        {
          workerId: 'worker-a',
          sessionId: 'session-a',
          toolCall: {
            toolCallId: 'call-reused',
            kind: 'edit',
            locations: [{ path: '/workspace/a.ts' }],
          },
        },
        {
          workerId: 'worker-b',
          sessionId: 'session-b',
          toolCall: {
            toolCallId: 'call-reused',
            kind: 'shell',
            rawInput: { command: 'echo worker-b' },
          },
        },
      ],
    });
    expect(result.content[0]?.text).toContain('ambiguous: true');
    expect(result.content[0]?.text).toContain('/workspace/a.ts');
    expect(result.content[0]?.text).toContain('echo worker-b');
  });
});
