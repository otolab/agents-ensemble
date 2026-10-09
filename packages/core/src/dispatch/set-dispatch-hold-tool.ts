import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import type {
  DispatchHoldChange,
  DispatchHoldState,
} from '../conductor/session/dispatch-hold.js';
import { yamlToolResult } from './yaml-tool-result.js';

export interface SetDispatchHoldToolOptions {
  state: DispatchHoldState;
  onChanged?: (change: DispatchHoldChange) => void;
  /** OFF 時、state を false にする前に queue の hold 対象を回収する。 */
  onBeforeRelease?: () => void;
}

/** conductor が harness → conductor の trigger dispatch を一時停止する tool。 */
export function createSetDispatchHoldTool(
  options: SetDispatchHoldToolOptions,
): ConductorToolSet {
  return {
    set_dispatch_hold: {
      name: 'set_dispatch_hold',
      description: [
        'Temporarily hold trigger SessionEvents before dispatching them to the conductor.',
        '`hold: true` is useful while reading an Issue/PR or coordinating several workers; held events are kept in arrival order.',
        '`operator.message` always bypasses the hold; `permission.pending` is held like other trigger events, and low-priority `permission.stall` is also a hold target.',
        'Normal dispatch prioritizes `permission.pending` and other actionable operator input over `permission.stall`.',
        'Events already queued before release are collected before the flush count is returned.',
        '`hold: false` releases the held trigger events, including permission.pending and permission.stall, for dispatch. Normally they arrive as one combined conductor send; after max-turns, permission may still be sent first for recovery while blocked worker events remain held.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          hold: {
            type: 'boolean',
            description:
              'true to hold worker/GitHub/permission.pending/permission.stall trigger events, false to release and flush them; permission.pending normally has priority over low-priority permission.stall, which may still arrive after max-turns for permission recovery',
          },
        },
        required: ['hold'],
      },
      async execute(args) {
        if (typeof args.hold !== 'boolean') {
          throw new Error('set_dispatch_hold requires boolean hold');
        }

        if (args.hold) {
          const status = options.state.dispatchHold ? 'updated' : 'enabled';
          options.state.dispatchHold = true;
          const heldEventCount = options.state.heldEvents.length;
          options.onChanged?.({
            status,
            hold: true,
            heldEventCount,
          });
          return yamlToolResult('set_dispatch_hold', {
            dispatchHold: true,
            heldEventCount,
            sendScheduled: false,
          });
        }

        options.onBeforeRelease?.();
        const flushedEventCount = options.state.heldEvents.length;
        options.state.dispatchHold = false;
        options.onChanged?.({
          status: 'released',
          hold: false,
          heldEventCount: options.state.heldEvents.length,
          flushedEventCount,
        });
        return yamlToolResult('set_dispatch_hold', {
          dispatchHold: false,
          flushedEventCount,
          sendScheduled: flushedEventCount > 0,
        });
      },
    },
  };
}
