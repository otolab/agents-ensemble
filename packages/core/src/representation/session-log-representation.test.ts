import { describe, expect, it } from 'vitest';
import {
  createSessionLogRepresentation,
  renderSessionLogEvent,
} from './session-log-representation.js';
import { parsePermissionRequest } from '../permission/permission-request.js';

describe('session log representation', () => {
  it('renders permission.pending through the core default entry point', () => {
    expect(
      renderSessionLogEvent({
        type: 'permission.pending',
        workerLabel: 'implementer',
        permission: {
          id: 'perm-3',
          workerId: 'worker-uuid',
          createdAt: 0,
          request: parsePermissionRequest({
            toolCall: {
              toolCallId: 'exec-1',
              rawInput: { command: 'pnpm test' },
            },
          }),
        },
      }),
    ).toBe('permission.pending worker=implementer tool=Shell cmd="pnpm test" id=perm-3');
  });

  it('registers a renderer by event type', () => {
    const representation = createSessionLogRepresentation();
    representation.register('harness.warning', (event) => `warning=${event.message}`);

    expect(
      representation.render({ type: 'harness.warning', message: 'disk nearly full' }),
    ).toBe('warning=disk nearly full');
  });

  it('returns undefined for an event without a registered renderer', () => {
    const representation = createSessionLogRepresentation();

    expect(
      representation.render({
        type: 'harness.warning',
        message: 'keep the existing CLI formatter',
      }),
    ).toBeUndefined();
  });
});
