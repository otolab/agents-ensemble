import { describe, expect, it } from 'vitest';
import { AcpBridge } from '../../src/acp/acp-bridge.js';
import { AcpClient } from '../../src/acp/acp-client.js';
import { createInProcessStreamPair } from '../../src/acp/testing/stream-pair.js';
import { startFakeAcpServer } from '../../src/acp/testing/fake-acp-server.js';
import { hasAcpTestConfig, getAcpTestConfig } from './test-config.js';

describe.skipIf(!hasAcpTestConfig())('AcpBridge integration', () => {
  it('runs a session against real agent acp', async () => {
    const config = getAcpTestConfig();
    const bridge = await AcpBridge.connect({
      command: config.agentCommand,
      args: config.agentArgs,
      cwd: config.cwd,
    });

    try {
      const result = await bridge.runSession({
        cwd: config.cwd ?? process.cwd(),
        prompt: 'Reply with exactly: pong',
      });
      expect(result.stopReason).toBeTruthy();
    } finally {
      await bridge.close();
    }
  }, 120_000);
});

describe('AcpBridge in-process', () => {
  it('runSession via FakeAcpServer', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });
    await client.connect();

    const sessionId = await client.newSession('/tmp');
    const result = await client.prompt(sessionId, 'hi');
    expect(result.stopReason).toBe('end_turn');
    await client.close();
  });
});
