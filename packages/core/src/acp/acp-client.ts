import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { JsonRpcPeer } from './json-rpc-peer.js';
import type { JsonRpcNotification, JsonRpcRequest } from './json-rpc.js';
import type { AcpAuthenticateStrategy } from './resolve-acp-auth.js';
import {
  DEFAULT_PERMISSION_DECISION,
  type AcpPromptBlock,
  type PermissionHandler,
  type PromptResult,
  type SessionUpdateNotification,
} from './types.js';

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
    this.peer.notify('session/cancel', { sessionId });
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
      })) as PromptResult;
      const responseText = responseChunks.join('');
      return {
        ...result,
        responseText: responseText || undefined,
        usage: result.usage,
      };
    } finally {
      this.promptUpdateHandler = undefined;
    }
  }

  async close(): Promise<void> {
    this.peer.close();
    this.options.childProcess?.stdin?.end();
    if (this.options.drainChildStderr) {
      await this.options.drainChildStderr();
    }
    if (this.options.childProcess) {
      await terminateChildProcess(this.options.childProcess);
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
    const decision = await handler(request.params);
    this.peer.respond(request.id, decision);
  }
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

export async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.stdin?.end();

  if (!child.killed) {
    child.kill('SIGTERM');
  }

  const exited = await waitForChildExit(child, 5_000);
  if (!exited && !child.killed) {
    child.kill('SIGKILL');
    await waitForChildExit(child, 2_000);
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
