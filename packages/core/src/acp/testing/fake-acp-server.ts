import type { Readable, Writable } from 'node:stream';
import {
  NdJsonLineBuffer,
  parseMessage,
  serializeMessage,
  type JsonRpcMessage,
} from '../json-rpc.js';

export interface FakeAcpPromptResult {
  stopReason: string;
  message?: string;
}

export interface FakeAcpServerOptions {
  readable: Readable;
  writable: Writable;
  /** Emit session/request_permission before responding to session/prompt. */
  requestPermissionOnPrompt?: boolean;
  /** Called when session/prompt is received. May push session/update via `notify`. */
  onPrompt?: (params: {
    sessionId: string;
    prompt: unknown;
    notify: (method: string, params: unknown) => void;
  }) => FakeAcpPromptResult | Promise<FakeAcpPromptResult>;
}

/**
 * Minimal ACP agent for unittest.
 * Implements initialize → authenticate → session/new → session/prompt.
 */
export class FakeAcpServer {
  private readonly lineBuffer = new NdJsonLineBuffer();
  private sessionCounter = 0;
  private permissionRequestCounter = 0;
  private running = false;
  private readonly pendingPermissionResolvers = new Map<
    string | number,
    () => void
  >();

  constructor(private readonly options: FakeAcpServerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.readable.setEncoding('utf8');
    this.options.readable.on('data', (chunk: string) => this.handleChunk(chunk));
  }

  stop(): void {
    this.running = false;
  }

  private handleChunk(chunk: string): void {
    for (const line of this.lineBuffer.push(chunk)) {
      void this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    const message = parseMessage(line);

    if ('id' in message && ('result' in message || 'error' in message)) {
      const resolvePermission = this.pendingPermissionResolvers.get(message.id);
      if (resolvePermission) {
        this.pendingPermissionResolvers.delete(message.id);
        resolvePermission();
      }
      return;
    }

    if (!('method' in message) || !('id' in message)) return;

    const { id, method, params } = message;

    switch (method) {
      case 'initialize':
        this.respond(id, {
          protocolVersion: 1,
          agentCapabilities: { session: {} },
          agentInfo: { name: 'fake-acp-server', version: '0.0.0' },
        });
        break;

      case 'authenticate':
        this.respond(id, {});
        break;

      case 'session/new': {
        this.sessionCounter += 1;
        this.respond(id, { sessionId: `fake-session-${this.sessionCounter}` });
        break;
      }

      case 'session/prompt': {
        const sessionId = (params as { sessionId?: string })?.sessionId ?? '';
        const prompt = (params as { prompt?: unknown })?.prompt;
        const notify = (notifyMethod: string, notifyParams: unknown) => {
          this.notify(notifyMethod, notifyParams);
        };

        if (this.options.requestPermissionOnPrompt) {
          await this.requestPermissionAndWait(sessionId);
        }

        const result = this.options.onPrompt
          ? await this.options.onPrompt({ sessionId, prompt, notify })
          : { stopReason: 'end_turn', message: 'ok' };

        if (!this.options.onPrompt && result.message) {
          notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: result.message },
            },
          });
        }

        this.respond(id, { stopReason: result.stopReason });
        break;
      }

      default:
        this.respond(id, {});
    }
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private requestPermissionAndWait(sessionId: string): Promise<void> {
    const requestId = `perm-${++this.permissionRequestCounter}`;
    return new Promise((resolve) => {
      this.pendingPermissionResolvers.set(requestId, resolve);
      this.write({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: { sessionId, toolName: 'test-tool' },
      });
    });
  }

  private write(message: JsonRpcMessage): void {
    this.options.writable.write(serializeMessage(message));
  }
}

export function startFakeAcpServer(
  options: FakeAcpServerOptions,
): FakeAcpServer {
  const server = new FakeAcpServer(options);
  server.start();
  return server;
}
