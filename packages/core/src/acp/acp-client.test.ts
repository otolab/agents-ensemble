import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AcpClient, terminateChildProcess } from './acp-client.js';
import { createInProcessStreamPair } from './testing/stream-pair.js';
import { startFakeAcpServer } from './testing/fake-acp-server.js';
import { SessionUsageTracker } from '../usage/session-usage-tracker.js';

describe('AcpClient', () => {
  it.each([
    {
      name: 'keeps explicit zero and non-zero cache counts',
      wireUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 123,
        cachedReadTokens: 0,
        cachedWriteTokens: 15,
        thoughtTokens: 4,
      },
      expectedUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 123,
        cacheReadTokens: 0,
        cacheWriteTokens: 15,
        reasoningTokens: 4,
      },
    },
    {
      name: 'keeps non-zero cache reads and explicit zero cache writes',
      wireUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 123,
        cachedReadTokens: 8,
        cachedWriteTokens: 0,
        thoughtTokens: 4,
      },
      expectedUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 123,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
        reasoningTokens: 4,
      },
    },
    {
      name: 'omits absent optional usage fields',
      wireUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
      expectedUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
    },
  ])('uses ACP v1 session/prompt and $name', async ({
    wireUsage,
    expectedUsage,
  }) => {
    const streams = createInProcessStreamPair();
    const initializeSpy = vi.fn();
    const promptSpy = vi.fn();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onInitialize: initializeSpy,
      onPrompt: (params) => {
        promptSpy(params);
        return { stopReason: 'end_turn', usage: wireUsage };
      },
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    const result = await client.prompt(sessionId, 'hello');

    expect(initializeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ protocolVersion: 1 }),
    );
    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    );
    expect(result.usage).toEqual(expectedUsage);

    const tracker = new SessionUsageTracker();
    const round = tracker.recordWorkerRound({
      name: 'codex',
      kind: 'implementer',
      prompt: 'hello',
      promptResult: result,
    });
    expect(round.usage).toMatchObject({ source: 'acp', ...expectedUsage });

    await client.close();
  });

  it('force-kills and reaps a child that ignores SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await once(child, 'spawn');
    await once(child.stdout!, 'data');

    await terminateChildProcess(child, {
      gracefulExitMs: 25,
      graceMs: 25,
      forceKillWaitMs: 1_000,
    });

    expect(child.signalCode).toBe('SIGKILL');
    expect(child.exitCode).toBeNull();
  });

  it('runs connect → newSession → prompt', async () => {
    const streams = createInProcessStreamPair();
    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onPrompt: ({ notify }) => {
        notify('session/update', {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    const updates: string[] = [];
    const result = await client.prompt(sessionId, 'hello', (update) => {
      const text = update.update?.content?.text;
      if (text) updates.push(text);
    });

    expect(sessionId).toMatch(/^fake-session-/);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toContain('done');

    await client.close();
  });

  it('skips authenticate when strategy is skip', async () => {
    const streams = createInProcessStreamPair();
    const authenticateSpy = vi.fn();

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onAuthenticate: authenticateSpy,
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      { authenticate: { kind: 'skip' } },
    );

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    expect(sessionId).toMatch(/^fake-session-/);
    expect(authenticateSpy).not.toHaveBeenCalled();

    await client.close();
  });

  it('uses preset-specific authenticate methodId', async () => {
    const streams = createInProcessStreamPair();
    const authenticateSpy = vi.fn();

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onAuthenticate: authenticateSpy,
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      { authenticate: { kind: 'method', methodId: 'chat-gpt' } },
    );

    await client.connect();
    expect(authenticateSpy).toHaveBeenCalledWith('chat-gpt');

    await client.close();
  });

  it('responds to session/request_permission', async () => {
    const streams = createInProcessStreamPair();
    const permissionHandler = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      requestPermissionOnPrompt: true,
    });

    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      { permissionHandler },
    );

    await client.connect();
    const sessionId = await client.newSession('/tmp');
    const result = await client.prompt(sessionId, 'run tool');

    expect(result.stopReason).toBe('end_turn');
    expect(permissionHandler).toHaveBeenCalledOnce();

    await client.close();
  });

  it('propagates permission response write failures to the caller', async () => {
    const streams = createInProcessStreamPair();
    const client = AcpClient.create(
      {
        readable: streams.clientReadable,
        writable: streams.clientWritable,
      },
      {
        permissionHandler: vi.fn().mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'allow-once' },
        }),
      },
    );
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    streams.clientWritable.destroy(error);

    await expect(
      client.handleRequest({
        jsonrpc: '2.0',
        id: 'permission-1',
        method: 'session/request_permission',
        params: { toolName: 'shell' },
      }),
    ).rejects.toThrow('write EPIPE');
  });

  it('cancels an in-flight prompt via session/cancel', async () => {
    const streams = createInProcessStreamPair();
    let releasePrompt: (() => void) | undefined;

    startFakeAcpServer({
      readable: streams.serverReadable,
      writable: streams.serverWritable,
      onPrompt: () =>
        new Promise((resolve) => {
          releasePrompt = () => resolve({ stopReason: 'end_turn' });
        }),
    });

    const client = AcpClient.create({
      readable: streams.clientReadable,
      writable: streams.clientWritable,
    });

    await client.connect();
    const sessionId = await client.newSession('/tmp');

    const promptPromise = client.prompt(sessionId, 'slow task');
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.cancelSession(sessionId);

    const result = await promptPromise;
    expect(result.stopReason).toBe('cancelled');
    expect(releasePrompt).toBeDefined();

    await client.close();
  });
});
