#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureBuiltinPiConfig } from './pi-builtin-config.js';
import {
  preparePiAcpSessionStorage,
  resolvePiAcpSessionMapPaths,
  setPrivatePiSessionStorageUmask,
} from './pi-session-map.js';
import { resolveBuiltinPiAcpEntrypointPath } from './pi-runtime.js';

setPrivatePiSessionStorageUmask();

async function main(): Promise<void> {
  const workerHome =
    process.env.HOME ??
    process.env.USERPROFILE ??
    process.env.PI_CODING_AGENT_DIR;
  if (!workerHome) {
    throw new Error('builtin worker HOME was not configured');
  }

  const legacyWorkerHome =
    process.env.ENSEMBLE_PI_LEGACY_WORKER_HOME || undefined;
  const sessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ?? join(workerHome, 'sessions');
  const workerStorageRoot =
    process.env.ENSEMBLE_PI_WORKER_STORAGE_ROOT ??
    dirname(dirname(workerHome));
  const workerStorageParent =
    process.env.ENSEMBLE_PI_WORKER_STORAGE_PARENT ??
    dirname(workerStorageRoot);
  const resumeSessionId =
    process.env.ENSEMBLE_PI_RESUME_SESSION_ID || undefined;
  const resumeCwd = process.env.ENSEMBLE_PI_RESUME_CWD || undefined;
  if (resumeSessionId && !resumeCwd) {
    throw new Error('saved builtin Pi session has no cwd for map validation');
  }
  if (!resumeSessionId && resumeCwd) {
    throw new Error('saved builtin Pi cwd has no session ID for map validation');
  }

  const releaseStorage = await preparePiAcpSessionStorage({
    workerStorageParent,
    workerStorageRoot,
    workerHome,
    sessionsDir: sessionDir,
    ...(legacyWorkerHome ? { legacyWorkerHome } : {}),
    mapPaths: resolvePiAcpSessionMapPaths(workerHome, legacyWorkerHome),
    ...(resumeSessionId && resumeCwd
      ? { resumeSession: { sessionId: resumeSessionId, cwd: resumeCwd } }
      : {}),
  });

  try {
    ensureBuiltinPiConfig({
      ...(process.env.PI_CODING_AGENT_DIR
        ? { agentDir: process.env.PI_CODING_AGENT_DIR }
        : {}),
    });

    await import(pathToFileURL(resolveBuiltinPiAcpEntrypointPath()).href);
  } finally {
    await releaseStorage();
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[acp] builtin Pi wrapper failed: ${detail}\n`);
  process.exitCode = 1;
}
