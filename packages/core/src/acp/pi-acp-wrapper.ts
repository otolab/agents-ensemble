#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureBuiltinPiConfig } from './pi-builtin-config.js';
import {
  migrateLegacyPiAcpSessionMap,
  resolvePiAcpSessionMapPaths,
} from './pi-session-map.js';
import { resolveBuiltinPiAcpEntrypointPath } from './pi-runtime.js';

async function main(): Promise<void> {
  const workerHome =
    process.env.HOME ??
    process.env.USERPROFILE ??
    process.env.PI_CODING_AGENT_DIR;
  if (!workerHome) {
    throw new Error('builtin worker HOME was not configured');
  }

  ensureBuiltinPiConfig({
    ...(process.env.PI_CODING_AGENT_DIR
      ? { agentDir: process.env.PI_CODING_AGENT_DIR }
      : {}),
  });
  migrateLegacyPiAcpSessionMap(resolvePiAcpSessionMapPaths(workerHome));

  await import(pathToFileURL(resolveBuiltinPiAcpEntrypointPath()).href);
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[acp] builtin Pi wrapper failed: ${detail}\n`);
  process.exitCode = 1;
}
