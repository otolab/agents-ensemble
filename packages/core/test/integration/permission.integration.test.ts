import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowOnce, deny } from '../../src/permission/permission-broker.js';
import { runPermissionWorkerSession } from './helpers/permission-scenario.js';

/** Fake ACP が送る permission リクエストの toolName */
const FAKE_TOOL = 'test-tool';

describe('permission integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-allows obvious policy matches without conductor pending', async () => {
    const result = await runPermissionWorkerSession({
      policy: { allowTools: [FAKE_TOOL], allowReadOnlyTools: false },
    });

    expect(result.permissionDecisions).toEqual([allowOnce()]);
    expect(result.pipeline.pending.size).toBe(0);
    expect(result.completed).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  it('auto-denies obvious denylist matches without conductor pending', async () => {
    const result = await runPermissionWorkerSession({
      policy: { denyTools: [FAKE_TOOL] },
    });

    expect(result.permissionDecisions).toEqual([deny()]);
    expect(result.pipeline.pending.size).toBe(0);
    expect(result.completed).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  it('defers non-obvious requests to conductor pending then resolves allow', async () => {
    const result = await runPermissionWorkerSession({
      policy: { allowTools: [], allowReadOnlyTools: false },
      resolvePending: ({ pipeline, session, pendingId }) => {
        pipeline.resolveAndFulfill(session.inbox, pendingId, true);
      },
    });

    expect(result.pipeline.pending.size).toBe(0);
    expect(result.completed).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(result.completed[0]?.promptResult.responseText).toBe('pong');
  });

  it('propagates conductor reject to worker after pending', async () => {
    const result = await runPermissionWorkerSession({
      policy: { allowTools: [], allowReadOnlyTools: false },
      resolvePending: ({ pipeline, session, pendingId }) => {
        pipeline.resolveAndFulfill(session.inbox, pendingId, false);
      },
    });

    expect(result.pipeline.pending.size).toBe(0);
    expect(result.completed).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  it('allows conductor veto after human would have approved (resolve deny)', async () => {
    const result = await runPermissionWorkerSession({
      policy: { allowTools: [], allowReadOnlyTools: false },
      resolvePending: ({ pipeline, session, pendingId }) => {
        // human approve を想定したうえで conductor が deny（veto）
        pipeline.resolveAndFulfill(session.inbox, pendingId, false);
      },
    });

    expect(result.pipeline.pending.list()).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });
});
