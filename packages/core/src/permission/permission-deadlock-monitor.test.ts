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

  it('treats pending permission as risk even without worker or attach activity', () => {
    expect(
      isPermissionDeadlockRisk({ attachInFlight: 1, hasProcessingWorker: false }, 1),
    ).toBe(true);
    expect(
      isPermissionDeadlockRisk({ attachInFlight: 0, hasProcessingWorker: true }, 1),
    ).toBe(true);
    expect(
      isPermissionDeadlockRisk({ attachInFlight: 0, hasProcessingWorker: false }, 1),
    ).toBe(true);
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
    const stalls: Array<{
      message: string;
      pendingPermissionIds: string[];
      pendingPermissionCount: number;
      oldestPermissionCreatedAt: number;
      stallAgeMs: number;
      stallThresholdMs: number;
    }> = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 0,
        hasProcessingWorker: false,
      }),
      onWarning: (message) => warnings.push(message),
      onStall: (stall) => stalls.push(stall),
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
    expect(stalls).toEqual([
      {
        message: formatPermissionDeadlockWarningMessage(
          DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
        ),
        pendingPermissionIds: ['perm-1'],
        pendingPermissionCount: 1,
        oldestPermissionCreatedAt: 0,
        stallAgeMs: DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
        stallThresholdMs: DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
      },
    ]);
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
    const stalls: unknown[] = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 0,
        hasProcessingWorker: false,
      }),
      onWarning: (message) => warnings.push(message),
      onStall: (stall) => stalls.push(stall),
      stallThresholdMs: 5_000,
      pollIntervalMs: 1_000,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(20_000);
    monitor.stop();

    expect(warnings).toHaveLength(1);
    expect(stalls).toHaveLength(1);
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
    const stalls: unknown[] = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 0,
        hasProcessingWorker: true,
      }),
      onWarning: (message) => warnings.push(message),
      onStall: (stall) => stalls.push(stall),
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
    expect(stalls).toHaveLength(2);
  });

  it.each([
    { scenario: 'a different request ID', replacementId: 'perm-2' },
    { scenario: 'the same request ID', replacementId: 'perm-1' },
  ])(
    'warns again when $scenario replaces the pending request between polls',
    ({ replacementId }) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      const pending = new PendingPermissionRegistry();
      const pipeline = new PermissionPipeline({ pending });
      const addPending = (id: string) => {
        pending.add({
          id,
          workerId: 'worker-1',
          createdAt: Date.now(),
          request: parsePermissionRequest({ toolName: 'Shell', raw: {} }),
        });
      };
      addPending('perm-1');

      const warnings: string[] = [];
      const stalls: Array<{
        pendingPermissionIds: string[];
        oldestPermissionCreatedAt: number;
      }> = [];
      const monitor = createPermissionDeadlockMonitor({
        pipeline,
        onWarning: (message) => warnings.push(message),
        onStall: (stall) => stalls.push(stall),
        stallThresholdMs: 1_000,
        pollIntervalMs: 100,
        now: () => Date.now(),
      });

      monitor.start();
      vi.advanceTimersByTime(1_000);
      // Replace the request before the next poll; the monitor never sees empty.
      pending.take('perm-1');
      addPending(replacementId);
      vi.advanceTimersByTime(1_000);
      vi.advanceTimersByTime(2_000);
      monitor.stop();

      expect(warnings).toHaveLength(2);
      expect(
        stalls.map(({ pendingPermissionIds, oldestPermissionCreatedAt }) => ({
          pendingPermissionIds,
          oldestPermissionCreatedAt,
        })),
      ).toEqual([
        { pendingPermissionIds: ['perm-1'], oldestPermissionCreatedAt: 0 },
        {
          pendingPermissionIds: [replacementId],
          oldestPermissionCreatedAt: 1_000,
        },
      ]);
    },
  );

  it('keeps overlapping requests in one episode and re-notifies for remaining new requests', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const pending = new PendingPermissionRegistry();
    const pipeline = new PermissionPipeline({ pending });
    const addPending = (id: string) => {
      pending.add({
        id,
        workerId: 'worker-1',
        createdAt: Date.now(),
        request: parsePermissionRequest({ toolName: 'Shell', raw: {} }),
      });
    };
    addPending('perm-1');
    addPending('perm-2');

    const warnings: string[] = [];
    const stalls: Array<{ pendingPermissionIds: string[] }> = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      onWarning: (message) => warnings.push(message),
      onStall: (stall) => stalls.push(stall),
      stallThresholdMs: 1_000,
      pollIntervalMs: 100,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(1_000);
    addPending('perm-3');
    pending.take('perm-1');
    vi.advanceTimersByTime(1_000);
    expect(stalls).toHaveLength(1);

    pending.take('perm-2');
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1_000);
    monitor.stop();

    expect(warnings).toHaveLength(2);
    expect(stalls.map((stall) => stall.pendingPermissionIds)).toEqual([
      ['perm-1', 'perm-2'],
      ['perm-3'],
    ]);
  });

  it('does not warn when there is no pending permission', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const pipeline = new PermissionPipeline({});
    const warnings: string[] = [];
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 1,
        hasProcessingWorker: true,
      }),
      onWarning: (message) => warnings.push(message),
      stallThresholdMs: 1_000,
      pollIntervalMs: 100,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(10_000);
    monitor.stop();

    expect(warnings).toEqual([]);
  });

  it('does not warn or restart after an explicit stop', () => {
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
      onWarning: (message) => warnings.push(message),
      stallThresholdMs: 1_000,
      pollIntervalMs: 100,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(500);
    monitor.stop();
    vi.advanceTimersByTime(2_000);
    monitor.start();
    vi.advanceTimersByTime(2_000);

    expect(warnings).toEqual([]);
  });

  it('stops polling after shutdown abort', () => {
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
    const shutdown = new AbortController();
    const monitor = createPermissionDeadlockMonitor({
      pipeline,
      getActivitySnapshot: () => ({
        attachInFlight: 0,
        hasProcessingWorker: false,
      }),
      onWarning: (message) => warnings.push(message),
      stallThresholdMs: 1_000,
      pollIntervalMs: 100,
      shutdownSignal: shutdown.signal,
      now: () => Date.now(),
    });

    monitor.start();
    vi.advanceTimersByTime(500);
    shutdown.abort();
    vi.advanceTimersByTime(2_000);
    monitor.start();
    vi.advanceTimersByTime(2_000);
    monitor.stop();

    expect(warnings).toEqual([]);
  });

  it('polls on the default interval', () => {
    expect(DEFAULT_PERMISSION_DEADLOCK_STALL_MS).toBe(300_000);
    expect(DEFAULT_PERMISSION_DEADLOCK_POLL_MS).toBe(5_000);
    expect(formatPermissionDeadlockWarningMessage()).toContain('300s');
  });
});
