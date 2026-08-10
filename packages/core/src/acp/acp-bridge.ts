import { AcpClient, type AcpClientOptions, type SessionUpdateHandler } from './acp-client.js';
import { spawnAcpProcess, type SpawnAcpProcessOptions } from './acp-process.js';
import type { PermissionHandler, PromptResult } from './types.js';

export interface AcpBridgeConnectOptions extends SpawnAcpProcessOptions {}

export interface AcpBridgeRunSessionOptions {
  cwd: string;
  prompt: string;
  /** 指定時は `session/load` で復元してから prompt する。失敗時は新規 session。 */
  resumeSessionId?: string;
  onUpdate?: SessionUpdateHandler;
  /** 注入 bridge 利用時も worker ごとの handler を渡せる。 */
  permissionHandler?: PermissionHandler;
}

export interface AcpBridgeRunSessionResult {
  sessionId: string;
  promptResult: PromptResult;
}

/**
 * Facade for dispatch: holds a connected ACP client over a child process.
 */
export class AcpBridge {
  private constructor(private readonly client: AcpClient) {}

  static async connect(
    options: AcpBridgeConnectOptions = {},
  ): Promise<AcpBridge> {
    const client = await spawnAcpProcess(options);
    await client.connect();
    return new AcpBridge(client);
  }

  /** 接続済みクライアントから生成（integration / in-process Fake 用）。 */
  static fromClient(client: AcpClient): AcpBridge {
    return new AcpBridge(client);
  }

  async newSession(cwd: string): Promise<string> {
    return this.client.newSession(cwd);
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    permissionHandler?: PermissionHandler,
  ): Promise<void> {
    if (permissionHandler) {
      return this.client.withPermissionHandler(permissionHandler, () =>
        this.client.loadSession(sessionId, cwd),
      );
    }
    return this.client.loadSession(sessionId, cwd);
  }

  async prompt(
    sessionId: string,
    prompt: string,
    onUpdate?: SessionUpdateHandler,
  ): Promise<PromptResult> {
    return this.promptSession(sessionId, prompt, { onUpdate });
  }

  async promptSession(
    sessionId: string,
    prompt: string,
    options?: {
      permissionHandler?: PermissionHandler;
      onUpdate?: SessionUpdateHandler;
    },
  ): Promise<PromptResult> {
    const run = () => this.client.prompt(sessionId, prompt, options?.onUpdate);
    if (options?.permissionHandler) {
      return this.client.withPermissionHandler(options.permissionHandler, run);
    }
    return run();
  }

  /** 進行中の prompt ターンを中止する。 */
  cancelSession(sessionId: string): void {
    this.client.cancelSession(sessionId);
  }

  /** Create session and run a single prompt (typical worker dispatch). */
  async runSession(
    options: AcpBridgeRunSessionOptions,
  ): Promise<AcpBridgeRunSessionResult> {
    const runPrompt = async (sessionId: string) =>
      this.prompt(sessionId, options.prompt, options.onUpdate);

    let sessionId = options.resumeSessionId;
    if (sessionId) {
      try {
        if (options.permissionHandler) {
          await this.client.withPermissionHandler(
            options.permissionHandler,
            () => this.loadSession(sessionId!, options.cwd),
          );
        } else {
          await this.loadSession(sessionId, options.cwd);
        }
      } catch {
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      sessionId = await this.newSession(options.cwd);
    }

    const promptResult = options.permissionHandler
      ? await this.client.withPermissionHandler(options.permissionHandler, () =>
          runPrompt(sessionId!),
        )
      : await runPrompt(sessionId);

    return { sessionId, promptResult };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export { AcpClient, type AcpClientOptions };
