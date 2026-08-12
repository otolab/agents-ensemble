import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingPermissionRegistry } from './pending-permission.js';
import { PermissionPipeline } from './permission-pipeline.js';
import {
  createPermissionDeadlockMonitor,
  DEFAULT_PERMISSION_DEADLOCK_POLL_MS,
  DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
  formatPermissionDeadlockWarningMessage,
  isPermissionDeadlockRisk,
} from './permission-deadlock-monitor.js';
import { parsePermissionRequest } from './permission-request.js';

describe('isPermissionDeadlockRisk', () => {
  it('is false when no pending permissions', () => {
    expect(
      isPermissionDeadlockRisk(
        { attachInFlight: 1, hasProcessingWorker: true },
        0,
      ),
    ).toBe(false);
  });

  it('is true when pending exists with attach or processing activity', () => {
    expect(
      isPermissionDeadlockRisk({ attachInFlight: 1, hasProcessingWorker: false }, 1),
    ).toBe(true);
    expect(
      isPermissionDeadlockRisk({ attachInFlight: 0, hasProcessingWorker: true }, 1),
    ).toBe(true);
    expect(
      isPermissionDeadlockRisk({ attachInFlight: 0, hasProcessingWorker: false }, 1),
    ).toBe(false);
  });
});

describe('createPermissionDeadlockMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns once when stall threshold is exceeded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const pending = new PendingPermissionRegistry();
    const pipeline = new PermissionPipeline({ pending });
    pending.add({
      id: 'perm-1',
      workerId: 'worker-1',
      createdAt: 0,
      request: parsePermissionRequest({
        toolCall: { type: 'shell', args: { command: 'ls' } },
      }),
    });

    const warnings: string[] = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 0,
        hasProcessingWorker: true,
      }),
      onWarning: (message) => warnings.push(message),
      stallThresholdMs: DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
      pollIntervalMs: 1_000,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(DEFAULT_PERMISSION_DEADLOCK_STALL_MS + 1_000);
    monitor.stop();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      formatPermissionDeadlockWarningMessage(DEFAULT_PERMISSION_DEADLOCK_STALL_MS),
    );
  });

  it('does not warn again while the same stall continues', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const pending = new PendingPermissionRegistry();
    const pipeline = new PermissionPipeline({ pending });
    pending.add({
      id: 'perm-1',
      workerId: 'worker-1',
      createdAt: 0,
      request: parsePermissionRequest({ toolName: 'Shell', raw: {} }),
    });

    const warnings: string[] = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 1,
        hasProcessingWorker: false,
      }),
      onWarning: (message) => warnings.push(message),
      stallThresholdMs: 5_000,
      pollIntervalMs: 1_000,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(20_000);
    monitor.stop();

    expect(warnings).toHaveLength(1);
  });

  it('resets warning after pending is cleared and can warn on a new stall', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const pending = new PendingPermissionRegistry();
    const pipeline = new PermissionPipeline({ pending });
    pending.add({
      id: 'perm-1',
      workerId: 'worker-1',
      createdAt: 0,
      request: parsePermissionRequest({ toolName: 'Shell', raw: {} }),
    });

    const warnings: string[] = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 0,
        hasProcessingWorker: true,
      }),
      onWarning: (message) => warnings.push(message),
      stallThresholdMs: 5_000,
      pollIntervalMs: 1_000,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(6_000);
    pending.take('perm-1');
    vi.advanceTimersByTime(10_000);
    pending.add({
      id: 'perm-2',
      workerId: 'worker-1',
      createdAt: Date.now(),
      request: parsePermissionRequest({ toolName: 'Shell', raw: {} }),
    });
    vi.advanceTimersByTime(6_000);
    monitor.stop();

    expect(warnings).toHaveLength(2);
  });

  it('polls on the default interval', () => {
    expect(DEFAULT_PERMISSION_DEADLOCK_POLL_MS).toBe(5_000);
  });
});
