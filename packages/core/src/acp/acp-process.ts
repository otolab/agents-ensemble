import { spawn, type ChildProcess } from 'node:child_process';
import { AcpClient, type AcpClientOptions } from './acp-client.js';
import type { PermissionHandler, PromptResult } from './types.js';
import type { SessionUpdateHandler } from './acp-client.js';

export interface SpawnAcpProcessOptions extends AcpClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunAcpSessionOptions {
  cwd: string;
  prompt: string;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
  spawn?: SpawnAcpProcessOptions;
}

/**
 * Spawn `agent acp` and return a connected client.
 */
export async function spawnAcpProcess(
  options: SpawnAcpProcessOptions = {},
): Promise<AcpClient> {
  const command = options.command ?? 'agent';
  const args = options.args ?? ['acp'];

  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    env: options.env ?? process.env,
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error(`Failed to open stdio for ${command} ${args.join(' ')}`);
  }

  return AcpClient.create(
    { readable: child.stdout, writable: child.stdin },
    { ...options, childProcess: child },
  );
}

/**
 * One-shot: spawn → connect → session/new → session/prompt → cleanup.
 */
export async function runAcpSession(
  options: RunAcpSessionOptions,
): Promise<PromptResult> {
  const client = await spawnAcpProcess(options.spawn);
  try {
    await client.connect();
    const sessionId = await client.newSession(options.cwd);
    return await client.prompt(sessionId, options.prompt, options.onUpdate);
  } finally {
    await client.close();
  }
}

export type { ChildProcess };
