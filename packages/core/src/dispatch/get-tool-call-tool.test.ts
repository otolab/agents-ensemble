import { describe, expect, it } from 'vitest';
import { ToolCallSnapshotRegistry } from '../runtime/tool-call-snapshot-registry.js';
import { createGetToolCallTool } from './get-tool-call-tool.js';

describe('createGetToolCallTool', () => {
  it('returns the complete accumulated tool call', async () => {
    const snapshots = new ToolCallSnapshotRegistry();
    snapshots.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-1',
      kind: 'edit',
      title: 'Edit File',
      rawInput: { newString: 'updated' },
    });
    snapshots.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-1',
      locations: [{ path: '/repo/src/example.ts' }],
    });
    const tool = createGetToolCallTool({ snapshots }).get_tool_call!;

    const result = await tool.execute({ toolCallId: 'call-edit-1' });

    expect(result.structuredContent).toEqual({
      toolCallId: 'call-edit-1',
      kind: 'edit',
      title: 'Edit File',
      rawInput: { newString: 'updated' },
      locations: [{ path: '/repo/src/example.ts' }],
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
});
