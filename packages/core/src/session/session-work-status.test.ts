import { describe, expect, it } from 'vitest';
import { classifySessionWorkStatus } from './session-work-status.js';

describe('classifySessionWorkStatus', () => {
  const base = { conductorSending: false, shuttingDown: false, unresolvedPermissions: false, pendingWorkerFailures: false };
  const worker = (state: 'processing' | 'idle' | 'sleeping' | 'attaching' | 'failed', permissionPending = false, queueDepth = 0) => ({ state, permissionPending, queueDepth });
  it('distinguishes unblocked worker rounds and known permission waits', () => {
    expect(classifySessionWorkStatus({ ...base, workers: [worker('processing')] })).toBe('working');
    expect(classifySessionWorkStatus({ ...base, workers: [worker('processing', true)] })).toBe('waiting');
    expect(classifySessionWorkStatus({ ...base, workers: [worker('processing', true), worker('processing')] })).toBe('working');
    expect(classifySessionWorkStatus({ ...base, pendingWorkerFailures: true, workers: [worker('processing')] })).toBe('working');
    expect(classifySessionWorkStatus({ ...base, workers: [worker('idle'), worker('sleeping')] })).toBe('waiting');
  });
  it('does not infer activity during transitions or from conductor send alone', () => {
    for (const input of [
      { ...base, workers: [worker('attaching')] },
      { ...base, workers: [worker('failed')] },
      { ...base, workers: [worker('idle', false, 1)] },
      { ...base, conductorSending: true, workers: [worker('idle')] },
      { ...base, unresolvedPermissions: true, workers: [worker('processing')] },
      { ...base, shuttingDown: true, workers: [worker('processing')] },
      { ...base, pendingWorkerFailures: true, workers: [worker('idle')] },
    ]) expect(classifySessionWorkStatus(input)).toBe('unknown');
  });
});
