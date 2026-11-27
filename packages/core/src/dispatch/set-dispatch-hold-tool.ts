import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import type {
  DispatchHoldChange,
  DispatchHoldState,
} from '../conductor/session/dispatch-hold.js';
import {
  createConductorCoreState,
  stepConductorCore,
} from '../conductor/conductor-transition-core.js';
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
        '`operator.message` bypasses the hold, and `operator.reconnect` is handled by the driver. `permission.pending` and other work triggers are held; the low-priority `permission.stall` recovery signal bypasses the hold after its configured threshold.',
        'Among eligible events, operator input and `permission.pending` take precedence; worker outcomes and `github.update` also come before the low-priority `permission.stall`. A standalone `harness.connectivity.recovered` trigger follows the stall. If a recovery poll includes GitHub updates, its recovery inform is bundled with `github.update` and follows the update batch priority. A held `permission.pending` is not eligible until release.',
        'The stall signal has no raw request details and does not release the hold; release explicitly if you need to inspect a held permission.',
        'Events already queued before release are collected before the flush count is returned.',
        '`hold: false` releases the held trigger events, including `permission.pending`, for dispatch. Normally they arrive as one combined conductor send; after max-turns, permission events can still dispatch for recovery while worker/GitHub events remain blocked.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          hold: {
            type: 'boolean',
            description:
              'true to hold work and permission.pending triggers; low-priority permission.stall bypasses the hold after its configured threshold without releasing it. The stall signal has no raw request details, so release to inspect a held permission.pending when needed. false releases held events; permission can still dispatch after max-turns for recovery',
          },
        },
        required: ['hold'],
      },
      async execute(args) {
        if (typeof args.hold !== 'boolean') {
          throw new Error('set_dispatch_hold requires boolean hold');
        }

        if (args.hold) {
          const transition = stepConductorCore(
            createConductorCoreState({
              dispatchHold: options.state.dispatchHold,
              heldEvents: options.state.heldEvents,
            }),
            { type: 'dispatchHold.set', enabled: true },
          );
          options.state.dispatchHold = transition.state.dispatchHold;
          const change = getDispatchHoldChange(transition.effects);
          if (change) options.onChanged?.(change);
          return yamlToolResult('set_dispatch_hold', {
            dispatchHold: true,
            heldEventCount: options.state.heldEvents.length,
            sendScheduled: false,
          });
        }

        options.onBeforeRelease?.();
        const transition = stepConductorCore(
          createConductorCoreState({
            dispatchHold: options.state.dispatchHold,
            heldEvents: options.state.heldEvents,
          }),
          { type: 'dispatchHold.set', enabled: false },
        );
        options.state.dispatchHold = transition.state.dispatchHold;
        const change = getDispatchHoldChange(transition.effects);
        if (change) options.onChanged?.(change);
        const flushedEventCount = change?.flushedEventCount ?? 0;
        return yamlToolResult('set_dispatch_hold', {
          dispatchHold: false,
          flushedEventCount,
          sendScheduled: flushedEventCount > 0,
        });
      },
    },
  };
}

function getDispatchHoldChange(
  effects: ReturnType<typeof stepConductorCore>['effects'],
): DispatchHoldChange | undefined {
  const changed = effects.find(
    (effect) =>
      effect.kind === 'action' &&
      effect.action.type === 'dispatchHoldChanged',
  );
  if (
    changed?.kind !== 'action' ||
    changed.action.type !== 'dispatchHoldChanged'
  ) {
    return undefined;
  }
  return {
    status: changed.action.status,
    hold: changed.action.hold,
    heldEventCount: changed.action.heldEventCount,
    ...(changed.action.flushedEventCount !== undefined
      ? { flushedEventCount: changed.action.flushedEventCount }
      : {}),
  };
}
