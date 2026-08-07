import { AcpBridge } from '../acp/acp-bridge.js';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler, PromptResult } from '../acp/types.js';
import { buildLibrarianPrompt } from '../prompt/build-prompt.js';

export interface LibrarianDispatchOptions {
  skillName: string;
  repoRoot: string;
  issueUrl?: string;
  prUrl?: string;
  spawn?: SpawnAcpProcessOptions;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
}

export interface LibrarianDispatchResult {
  skillName: string;
  cwd: string;
  issueUrl?: string;
  prUrl?: string;
  prompt: string;
  promptResult: PromptResult;
}

export async function dispatchLibrarian(
  options: LibrarianDispatchOptions,
): Promise<LibrarianDispatchResult> {
  const cwd = options.repoRoot;
  const prompt = buildLibrarianPrompt({
    skillName: options.skillName,
    repoRoot: cwd,
    issueUrl: options.issueUrl,
    prUrl: options.prUrl,
  });

  const bridge = await AcpBridge.connect({
    cwd,
    permissionHandler: options.permissionHandler,
    ...options.spawn,
  });

  try {
    const promptResult = await bridge.runSession({
      cwd,
      prompt,
      onUpdate: options.onUpdate,
    });

    return {
      skillName: options.skillName,
      cwd,
      issueUrl: options.issueUrl,
      prUrl: options.prUrl,
      prompt,
      promptResult,
    };
  } finally {
    await bridge.close();
  }
}
