import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { JsonRpcPeer } from './json-rpc-peer.js';
import type { JsonRpcNotification, JsonRpcRequest } from './json-rpc.js';
import type { AcpAuthenticateStrategy } from './resolve-acp-auth.js';
import {
  DEFAULT_PERMISSION_DECISION,
  type AcpPromptBlock,
  type LlmUsageSnapshot,
  type PermissionHandler,
  type PromptResult,
  type SessionUpdateNotification,
} from './types.js';

interface AcpWireUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

interface AcpWirePromptResult {
  stopReason: string;
  usage?: AcpWireUsage;
}

export interface AcpClientOptions {
  permissionHandler?: PermissionHandler;
  clientName?: string;
  clientVersion?: string;
  /** preset 解決結果。未指定時は Cursor 互換の `cursor_login`。 */
  authenticate?: AcpAuthenticateStrategy;
  /** Set when backed by a child process (for cleanup). */
  childProcess?: ChildProcess;
  /** 子プロセス stderr capture の drain（close 時に呼ぶ）。 */
  drainChildStderr?: () => Promise<void>;
}

export type SessionUpdateHandler = (
  update: SessionUpdateNotification,
) => void;

export interface AcpClientStreams {
  readable: Readable;
  writable: Writable;
}

/**
 * High-level ACP client: initialize → authenticate → session/* .
 */
export class AcpClient {
  readonly peer: JsonRpcPeer;
  private promptUpdateHandler?: SessionUpdateHandler;
  private permissionHandlerOverride?: PermissionHandler;

  private constructor(
    peer: JsonRpcPeer,
    private readonly options: AcpClientOptions,
  ) {
    this.peer = peer;
  }

  static create(
    streams: AcpClientStreams,
    options: AcpClientOptions = {},
  ): AcpClient {
    const holder: { client?: AcpClient } = {};
    const peer = new JsonRpcPeer({
      readable: streams.readable,
      writable: streams.writable,
      onNotification: (notification) =>
        holder.client?.handleNotification(notification),
      onRequest: (request) => holder.client?.handleRequest(request),
    });
    const client = new AcpClient(peer, options);
    holder.client = client;
    return client;
  }

  get childProcess(): ChildProcess | undefined {
    return this.options.childProcess;
  }

  async initialize(): Promise<void> {
    await this.peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: optionsClientName(this.options),
        version: optionsClientVersion(this.options),
      },
    });
  }

  async authenticate(methodId = 'cursor_login'): Promise<void> {
    await this.peer.request('authenticate', { methodId });
  }

  async connect(): Promise<void> {
    await this.initialize();
    const auth = this.options.authenticate ?? {
      kind: 'method',
      methodId: 'cursor_login',
    };
    if (auth.kind === 'method') {
      await this.authenticate(auth.methodId);
    }
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.peer.request('session/new', {
      cwd,
      mcpServers,
    })) as { sessionId: string };
    return result.sessionId;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<void> {
    await this.peer.request('session/load', {
      sessionId,
      cwd,
      mcpServers,
    });
  }

  /** 進行中の `session/prompt` を中止する（ACP `session/cancel` notification）。 */
  cancelSession(sessionId: string): void {
    // Cancellation is best effort. A failed write closes the peer and rejects
    // the active prompt request; do not create an unhandled rejection here.
    void this.peer.notify('session/cancel', { sessionId }).catch(() => {
      // The active prompt observes the same transport failure.
    });
  }

  async prompt(
    sessionId: string,
    prompt: string | AcpPromptBlock[],
    onUpdate?: SessionUpdateHandler,
  ): Promise<PromptResult> {
    const responseChunks: string[] = [];
    const wrappedOnUpdate: SessionUpdateHandler = (update) => {
      const text = update.update?.content?.text;
      if (typeof text === 'string' && text.length > 0) {
        responseChunks.push(text);
      }
      onUpdate?.(update);
    };

    this.promptUpdateHandler = wrappedOnUpdate;
    try {
      const blocks = typeof prompt === 'string'
        ? [{ type: 'text' as const, text: prompt }]
        : prompt;
      const result = (await this.peer.request('session/prompt', {
        sessionId,
        prompt: blocks,
      })) as AcpWirePromptResult;
      const responseText = responseChunks.join('');
      return {
        ...result,
        responseText: responseText || undefined,
        usage: result.usage ? normalizeAcpUsage(result.usage) : undefined,
      };
    } finally {
      this.promptUpdateHandler = undefined;
    }
  }

  async close(): Promise<void> {
    this.peer.close();
    if (this.options.childProcess) {
      await terminateChildProcess(this.options.childProcess);
    }
    if (this.options.drainChildStderr) {
      await this.options.drainChildStderr();
    }
  }

  withPermissionHandler<T>(
    handler: PermissionHandler,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.permissionHandlerOverride;
    this.permissionHandlerOverride = handler;
    return fn().finally(() => {
      this.permissionHandlerOverride = previous;
    });
  }

  handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'session/update') return;
    this.promptUpdateHandler?.(
      notification.params as SessionUpdateNotification,
    );
  }

  async handleRequest(request: JsonRpcRequest): Promise<void> {
    if (request.method !== 'session/request_permission') return;
    const handler =
      this.permissionHandlerOverride ??
      this.options.permissionHandler ??
      defaultPermissionHandler;
    try {
      const decision = await handler(request.params);
      await this.peer.respond(request.id, decision);
    } catch (error) {
      // A permission response cannot be retried after the ACP pipe is gone.
      // Closing the peer rejects the in-flight prompt, which lets the worker
      // runtime publish worker.failed and deny any still-pending permission.
      this.peer.close();
      throw error;
    }
  }
}

function normalizeAcpUsage(usage: AcpWireUsage): LlmUsageSnapshot {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
    ...(typeof usage.cachedReadTokens === 'number'
      ? { cacheReadTokens: usage.cachedReadTokens }
      : {}),
    ...(typeof usage.cachedWriteTokens === 'number'
      ? { cacheWriteTokens: usage.cachedWriteTokens }
      : {}),
    ...(typeof usage.thoughtTokens === 'number'
      ? { reasoningTokens: usage.thoughtTokens }
      : {}),
  };
}

function optionsClientName(options: AcpClientOptions): string {
  return options.clientName ?? 'agents-ensemble';
}

function optionsClientVersion(options: AcpClientOptions): string {
  return options.clientVersion ?? '0.0.0';
}

function defaultPermissionHandler(): typeof DEFAULT_PERMISSION_DECISION {
  return DEFAULT_PERMISSION_DECISION;
}

export interface ChildProcessTerminationOptions {
  /** Time to let the child exit after stdin EOF before sending SIGTERM. */
  gracefulExitMs?: number;
  /** Grace period after SIGTERM before SIGKILL. */
  graceMs?: number;
  /** Maximum time to wait for the child to be reaped after SIGKILL. */
  forceKillWaitMs?: number;
}

export async function terminateChildProcess(
  child: ChildProcess,
  options: ChildProcessTerminationOptions = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.stdin?.end();

  const exitedGracefully = await waitForChildExit(
    child,
    options.gracefulExitMs ?? 500,
  );
  if (exitedGracefully) return;

  child.kill('SIGTERM');
  const exited = await waitForChildExit(child, options.graceMs ?? 5_000);
  if (!exited) {
    child.kill('SIGKILL');
    const forceKilled = await waitForChildExit(
      child,
      options.forceKillWaitMs ?? 2_000,
    );
    if (!forceKilled) {
      throw new Error(
        `Child process ${child.pid ?? '<unknown>'} did not exit after SIGKILL`,
      );
    }
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };

    child.once('exit', onExit);
  });
}
