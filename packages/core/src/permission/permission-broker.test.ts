import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../acp/acp-client.js';
import { createInProcessStreamPair } from '../acp/testing/stream-pair.js';
import { startFakeAcpServer } from '../acp/testing/fake-acp-server.js';
import {
  PermissionBroker,
  allowOnce,
  deny,
} from './permission-broker.js';

describe('PermissionBroker', () => {
  it('bridges backend option ids through an ACP permission request', async () => {
    const streams = createInProcessStreamPair();
    const broker = new PermissionBroker({
      policy: { allowTools: ['test-tool'] },
    });
    let response: unknown;

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
      permissionOptions: [
        { optionId: 'codex-allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'codex-reject', name: 'Reject', kind: 'reject_once' },
      ],
      onPermissionResponse: (decision) => {
        response = decision;
      },
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      { permissionHandler: broker.createHandler() },
    );

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    await client.prompt(sessionId, 'run');

    expect(response).toEqual({
      outcome: { outcome: 'selected', optionId: 'codex-allow' },
    });

    await client.close();
  });

  it('returns backend option ids for allow and deny decisions', async () => {
    const allowBroker = new PermissionBroker({
      policy: { allowTools: ['shell'] },
    });
    const denyBroker = new PermissionBroker({
      policy: { denyTools: ['shell'] },
    });
    const options = [
      { optionId: 'backend-allow', kind: 'allow_once' },
      { optionId: 'backend-allow-always', kind: 'allow_always' },
      { optionId: 'backend-deny', kind: 'reject_once' },
    ];

    await expect(
      allowBroker.decide({ toolName: 'Shell', options }),
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'backend-allow' },
    });
    await expect(
      denyBroker.decide({ toolName: 'Shell', options }),
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'backend-deny' },
    });
  });

  it('keeps legacy fallback ids when backend options are absent or unknown', async () => {
    const broker = new PermissionBroker({
      policy: { allowTools: ['shell'] },
    });
    const denyBroker = new PermissionBroker({
      policy: { denyTools: ['shell'] },
    });
    const handler = broker.createHandler();

    await expect(handler({ toolName: 'Shell' })).resolves.toEqual(allowOnce());
    await expect(
      handler({
        toolName: 'Shell',
        options: [{ optionId: 'backend-other', kind: 'unknown' }],
      }),
    ).resolves.toEqual(allowOnce());
    await expect(
      denyBroker.decide({
        toolName: 'Shell',
        options: [{ optionId: 'backend-other', kind: 'unknown' }],
      }),
    ).resolves.toEqual(deny());
  });

  it('auto-allows read-only tools via policy', async () => {
    const broker = new PermissionBroker({
      policy: { allowReadOnlyTools: true },
    });
    const handler = broker.createHandler('worker-1');

    await expect(handler({ toolName: 'Read' })).resolves.toEqual(allowOnce());
    await expect(handler({ toolName: 'Shell' })).resolves.toEqual(allowOnce());
  });

  it('denies denylisted tools', async () => {
    const streams = createInProcessStreamPair();
    const broker = new PermissionBroker({
      policy: { denyTools: ['test-tool'] },
    });
    const handler = broker.createHandler();
    const decisions: Awaited<ReturnType<typeof handler>>[] = [];
    const wrapped = async (params: unknown) => {
      const decision = await handler(params);
      decisions.push(decision);
      return decision;
    };

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
      onPrompt: () => ({ stopReason: 'end_turn' }),
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      { permissionHandler: wrapped },
    );

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    await client.prompt(sessionId, 'run');

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(deny());

    await client.close();
  });

  it('serializes concurrent permission handlers', async () => {
    const broker = new PermissionBroker({
      policy: { allowReadOnlyTools: false },
      onAsk: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return allowOnce();
      },
    });

    const handler = broker.createHandler();
    const first = handler({ toolName: 'Shell' });
    const second = handler({ toolName: 'Write' });

    await Promise.all([first, second]);
    expect(await first).toEqual(allowOnce());
    expect(await second).toEqual(allowOnce());
  });
});
