import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { JsonRpcPeer } from '../../src/acp/json-rpc-peer.js';
import { hasAcpTestConfig, getAcpTestConfig } from './test-config.js';

describe.skipIf(!hasAcpTestConfig())('agent acp integration', () => {
  it('completes initialize → session/new → session/prompt', async () => {
    const config = getAcpTestConfig();
    const command = config.agentCommand ?? 'agent';
    const args = config.agentArgs ?? ['acp'];

    const child = spawn(command, args, {
      cwd: config.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to open stdio pipes for agent acp');
    }

    const peer = new JsonRpcPeer({
      readable: child.stdout,
      writable: child.stdin,
    });

    try {
      await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'agents-ensemble-test', version: '0.0.0' },
      });

      await peer.request('authenticate', { methodId: 'cursor_login' });

      const session = (await peer.request('session/new', {
        cwd: config.cwd ?? process.cwd(),
        mcpServers: [],
      })) as { sessionId: string };

      expect(session.sessionId).toBeTruthy();

      const result = (await peer.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Reply with exactly: pong' }],
      })) as { stopReason: string };

      expect(result.stopReason).toBeTruthy();
    } finally {
      peer.close();
      child.stdin.end();
      child.kill();
    }
  }, 120_000);
});
