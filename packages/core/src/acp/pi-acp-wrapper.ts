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
  const workerStorageRoot = dirname(dirname(workerHome));
  preparePiAcpSessionStorage({
    workerStorageParent: dirname(workerStorageRoot),
    workerStorageRoot,
    workerHome,
    sessionsDir: sessionDir,
    ...(legacyWorkerHome ? { legacyWorkerHome } : {}),
    mapPaths: resolvePiAcpSessionMapPaths(workerHome, legacyWorkerHome),
  });

  ensureBuiltinPiConfig({
    ...(process.env.PI_CODING_AGENT_DIR
      ? { agentDir: process.env.PI_CODING_AGENT_DIR }
      : {}),
  });

  await import(pathToFileURL(resolveBuiltinPiAcpEntrypointPath()).href);
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[acp] builtin Pi wrapper failed: ${detail}\n`);
  process.exitCode = 1;
}
