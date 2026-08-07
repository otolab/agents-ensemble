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
