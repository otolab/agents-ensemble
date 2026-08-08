import { AcpClient, type AcpClientOptions, type SessionUpdateHandler } from './acp-client.js';
import { spawnAcpProcess, type SpawnAcpProcessOptions } from './acp-process.js';
import type { PermissionHandler, PromptResult } from './types.js';

export interface AcpBridgeConnectOptions extends SpawnAcpProcessOptions {}

export interface AcpBridgeRunSessionOptions {
  cwd: string;
  prompt: string;
  onUpdate?: SessionUpdateHandler;
  /** 注入 bridge 利用時も worker ごとの handler を渡せる。 */
  permissionHandler?: PermissionHandler;
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

  async prompt(
    sessionId: string,
    prompt: string,
    onUpdate?: SessionUpdateHandler,
  ): Promise<PromptResult> {
    return this.client.prompt(sessionId, prompt, onUpdate);
  }

  /** Create session and run a single prompt (typical worker dispatch). */
  async runSession(options: AcpBridgeRunSessionOptions): Promise<PromptResult> {
    const sessionId = await this.newSession(options.cwd);
    if (options.permissionHandler) {
      return this.client.withPermissionHandler(options.permissionHandler, () =>
        this.prompt(sessionId, options.prompt, options.onUpdate),
      );
    }
    return this.prompt(sessionId, options.prompt, options.onUpdate);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export { AcpClient, type AcpClientOptions };
