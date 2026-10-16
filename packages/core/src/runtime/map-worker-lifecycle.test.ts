import { describe, expect, it } from 'vitest';
import { mapHarnessToDisplayStatus } from './map-worker-lifecycle.js';
import type { WorkerLifecycleState } from './worker-lifecycle-state.js';

describe('mapHarnessToDisplayStatus', () => {
  it.each<[WorkerLifecycleState, 'sleep' | 'idle' | 'running' | 'failed']>([
    ['attaching', 'running'],
    ['processing', 'running'],
    ['idle', 'idle'],
    ['sleeping', 'sleep'],
    ['failed', 'failed'],
  ])('maps %s to %s', (lifecycle, expected) => {
    expect(mapHarnessToDisplayStatus(lifecycle)).toBe(expected);
  });
});
