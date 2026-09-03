import { describe, expect, it } from 'vitest';
import { ConductorInbox } from '../runtime/conductor-inbox.js';
import { startInboxProcessor } from '../runtime/inbox-processor.js';
import { PermissionPipeline } from './permission-pipeline.js';
import { createResolvePermissionTool } from './resolve-permission-tool.js';

describe('PermissionPipeline', () => {
  it('resolves obvious allow/deny immediately', () => {
    const pipeline = new PermissionPipeline({
      policy: { allowTools: ['read'], denyTools: ['shell'], allowReadOnlyTools: false },
    });

    const allow = pipeline.evaluate('req-1', 'worker-1', {
      toolName: 'read',
      options: [{ optionId: 'backend-allow', kind: 'allow_once' }],
      raw: {},
    });
    expect(allow).toEqual({
      status: 'resolved',
      decision: { outcome: { outcome: 'selected', optionId: 'backend-allow' } },
    });

    const denied = pipeline.evaluate('req-2', 'worker-1', {
      toolName: 'shell',
      options: [{ optionId: 'backend-deny', kind: 'reject_once' }],
      raw: {},
    });
    expect(denied).toEqual({
      status: 'resolved',
      decision: { outcome: { outcome: 'selected', optionId: 'backend-deny' } },
    });
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
    const decisionPromise = handler({
      toolName: 'Shell',
      options: [{ optionId: 'backend-deny', kind: 'reject_once' }],
      raw: {},
    });
    await inbox.drain();
    const pendingId = pipeline.pending.list()[0]!.id;

    pipeline.resolveAndFulfill(inbox, pendingId, false);
    await expect(decisionPromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'backend-deny' },
    });
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
    const decisionPromise = handler({
      toolName: 'Shell',
      options: [{ optionId: 'backend-allow', kind: 'allow_once' }],
      raw: {},
    });
    await inbox.drain();
    const pendingId = pipeline.pending.list()[0]!.id;

    const result = await tools.resolve_permission.execute({
      requestId: pendingId,
      decision: 'allow',
      reason: 'smoke test',
    });

    await expect(decisionPromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'backend-allow' },
    });
    expect(result.structuredContent).toMatchObject({
      requestId: pendingId,
      decision: 'allow',
      toolName: 'Shell',
      reason: 'smoke test',
    });
    await processor.stop();
  });
});
