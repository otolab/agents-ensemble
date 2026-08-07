import { AcpClient, type AcpClientOptions, type SessionUpdateHandler } from './acp-client.js';
import { spawnAcpProcess, type SpawnAcpProcessOptions } from './acp-process.js';
import type { PromptResult } from './types.js';

export interface AcpBridgeConnectOptions extends SpawnAcpProcessOptions {}

export interface AcpBridgeRunSessionOptions {
  cwd: string;
  prompt: string;
  onUpdate?: SessionUpdateHandler;
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
    return this.prompt(sessionId, options.prompt, options.onUpdate);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export { AcpClient, type AcpClientOptions };
