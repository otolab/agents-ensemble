import { describe, expect, it } from 'vitest';
import {
  createDispatchHoldState,
  type DispatchHoldChange,
} from '../conductor/session/dispatch-hold.js';
import { createSetDispatchHoldTool } from './set-dispatch-hold-tool.js';

function toolText(result: { content: Array<{ text?: string }> }): string {
  return String(result.content[0]?.text ?? '');
}

describe('createSetDispatchHoldTool', () => {
  it('enables hold and reports the current buffered count', async () => {
    const state = createDispatchHoldState();
    const changes: DispatchHoldChange[] = [];
    const tools = createSetDispatchHoldTool({
      state,
      onChanged: (change) => changes.push(change),
    });

    const result = await tools.set_dispatch_hold!.execute({ hold: true });

    expect(state.dispatchHold).toBe(true);
    expect(toolText(result)).toContain('# set_dispatch_hold');
    expect(result.structuredContent).toEqual({
      dispatchHold: true,
      heldEventCount: 0,
      sendScheduled: false,
    });
    expect(changes).toEqual([
      { status: 'enabled', hold: true, heldEventCount: 0 },
    ]);
  });

  it('releases hold and reports whether a flush send is scheduled', async () => {
    const state = createDispatchHoldState();
    state.dispatchHold = true;
    state.heldEvents.push(
      { type: 'github.update', items: [] },
      { type: 'github.update', items: [] },
    );
    const changes: DispatchHoldChange[] = [];
    const tools = createSetDispatchHoldTool({
      state,
      onChanged: (change) => changes.push(change),
    });

    const result = await tools.set_dispatch_hold!.execute({ hold: false });

    expect(state.dispatchHold).toBe(false);
    expect(state.heldEvents).toHaveLength(2);
    expect(toolText(result)).toContain('flushedEventCount: 2');
    expect(result.structuredContent).toEqual({
      dispatchHold: false,
      flushedEventCount: 2,
      sendScheduled: true,
    });
    expect(changes).toEqual([
      {
        status: 'released',
        hold: false,
        heldEventCount: 0,
        flushedEventCount: 2,
      },
    ]);
  });

  it('rejects a non-boolean hold argument', async () => {
    const tools = createSetDispatchHoldTool({ state: createDispatchHoldState() });

    await expect(tools.set_dispatch_hold!.execute({ hold: 'true' })).rejects.toThrow(
      'set_dispatch_hold requires boolean hold',
    );
  });
});
