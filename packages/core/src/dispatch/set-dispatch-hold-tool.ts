import type { SDKCustomTool } from '@cursor/sdk';
import type {
  DispatchHoldChange,
  DispatchHoldState,
} from '../conductor/session/dispatch-hold.js';
import { yamlToolResult } from './yaml-tool-result.js';

export interface SetDispatchHoldToolOptions {
  state: DispatchHoldState;
  onChanged?: (change: DispatchHoldChange) => void;
}

/** conductor が harness → conductor の trigger dispatch を一時停止する tool。 */
export function createSetDispatchHoldTool(
  options: SetDispatchHoldToolOptions,
): Record<string, SDKCustomTool> {
  return {
    set_dispatch_hold: {
      description: [
        'Temporarily hold trigger SessionEvents before dispatching them to the conductor.',
        '`hold: true` is useful while reading an Issue/PR or coordinating several workers; held events are kept in arrival order.',
        '`operator.message` and `permission.pending` always bypass the hold.',
        '`hold: false` releases the held trigger events as one combined conductor send.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          hold: {
            type: 'boolean',
            description:
              'true to hold worker/GitHub trigger events, false to release and flush them',
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

        const flushedEventCount = options.state.heldEvents.length;
        options.state.dispatchHold = false;
        options.onChanged?.({
          status: 'released',
          hold: false,
          heldEventCount: 0,
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
