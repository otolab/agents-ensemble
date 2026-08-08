import { describe, expect, it } from 'vitest';
import { ConductorInbox } from '../runtime/conductor-inbox.js';
import { startInboxProcessor } from '../runtime/inbox-processor.js';
import { PermissionPipeline } from './permission-pipeline.js';
import { allowOnce, deny } from './permission-broker.js';
import { createResolvePermissionTool } from './resolve-permission-tool.js';

describe('PermissionPipeline', () => {
  it('resolves obvious allow/deny immediately', () => {
    const pipeline = new PermissionPipeline({
      policy: { allowTools: ['read'], denyTools: ['shell'], allowReadOnlyTools: false },
    });

    const allow = pipeline.evaluate('req-1', 'worker-1', {
      toolName: 'read',
      raw: {},
    });
    expect(allow).toEqual({ status: 'resolved', decision: allowOnce() });

    const denied = pipeline.evaluate('req-2', 'worker-1', {
      toolName: 'shell',
      raw: {},
    });
    expect(denied).toEqual({ status: 'resolved', decision: deny() });
    expect(pipeline.pending.size).toBe(0);
  });

  it('defers non-obvious requests to pending', () => {
    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });

    const outcome = pipeline.evaluate('req-3', 'worker-1', {
      toolName: 'Shell',
      raw: {},
    });
    expect(outcome).toEqual({ status: 'deferred' });
    expect(pipeline.pending.list()).toHaveLength(1);
  });

  it('resolveAndFulfill propagates decision to inbox', async () => {
    const inbox = new ConductorInbox();
    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });

    const processor = startInboxProcessor({
      inbox,
      decidePermission: (request, workerId, requestId) => {
        const outcome = pipeline.evaluate(requestId, workerId, request);
        return outcome.status === 'resolved' ? outcome.decision : null;
      },
    });

    const handler = inbox.createPermissionHandler('worker-1');
    const decisionPromise = handler({ toolName: 'Shell', raw: {} });
    await inbox.drain();
    const pendingId = pipeline.pending.list()[0]!.id;

    pipeline.resolveAndFulfill(inbox, pendingId, false);
    await expect(decisionPromise).resolves.toEqual(deny());
    await processor.stop();
  });
});

describe('createResolvePermissionTool', () => {
  it('resolves pending permission via tool execute', async () => {
    const inbox = new ConductorInbox();
    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const tools = createResolvePermissionTool({ pipeline, inbox });

    const processor = startInboxProcessor({
      inbox,
      decidePermission: (request, workerId, requestId) => {
        const outcome = pipeline.evaluate(requestId, workerId, request);
        return outcome.status === 'resolved' ? outcome.decision : null;
      },
    });

    const handler = inbox.createPermissionHandler('worker-1');
    const decisionPromise = handler({ toolName: 'Shell', raw: {} });
    await inbox.drain();
    const pendingId = pipeline.pending.list()[0]!.id;

    const result = await tools.resolve_permission.execute({
      requestId: pendingId,
      decision: 'allow',
      reason: 'smoke test',
    });

    await expect(decisionPromise).resolves.toEqual(allowOnce());
    expect(result.structuredContent).toMatchObject({
      requestId: pendingId,
      decision: 'allow',
      toolName: 'Shell',
      reason: 'smoke test',
    });
    await processor.stop();
  });
});
