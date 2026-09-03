import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { AcpClient, type AcpClientOptions } from './acp-client.js';
import {
  attachChildProcessStderrCapture,
  type WorkerProcessStdioLine,
  type WorkerProcessStdioLineHandler,
} from './process-stream-capture.js';
import type { PermissionHandler, PromptResult } from './types.js';
import type { SessionUpdateHandler } from './acp-client.js';

export interface SpawnAcpProcessOptions extends AcpClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** worker attach 時に設定。子プロセス stdio capture のラベル用。 */
  workerName?: string;
  /** stderr 行を harness へ渡す（SessionLogger 等）。 */
  onProcessStdioLine?: WorkerProcessStdioLineHandler;
}

export type { WorkerProcessStdioLine, WorkerProcessStdioLineHandler };

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
  const cwd = options.cwd ?? process.cwd();

  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error(`Failed to open stdio for ${command} ${args.join(' ')}`);
  }

  const { drainStderr } = attachChildProcessStderrCapture(child.stderr, {
    workerName: options.workerName,
    cwd,
    onLine: options.onProcessStdioLine,
  });

  const drainChildStderr = async (): Promise<void> => {
    if (!child.stderr.readableEnded) {
      await Promise.race([
        once(child.stderr, 'end'),
        once(child, 'exit'),
      ]);
    }
    await drainStderr();
  };

  return AcpClient.create(
    { readable: child.stdout, writable: child.stdin },
    { ...options, childProcess: child, drainChildStderr },
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
