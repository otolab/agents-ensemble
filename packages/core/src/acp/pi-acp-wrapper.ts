#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureBuiltinPiConfig } from './pi-builtin-config.js';
import {
  migrateLegacyPiAcpSessionMap,
  resolvePiAcpSessionMapPaths,
} from './pi-session-map.js';

const require = createRequire(import.meta.url);

function resolveUpstreamPiAcpEntrypoint(): string {
  const packageJsonPath = require.resolve('pi-acp/package.json');
  const packageDirectory = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    bin?: unknown;
  };
  if (packageJson.name !== 'pi-acp') {
    throw new Error('resolved package is not the upstream pi-acp package');
  }

  const bin =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin &&
          typeof packageJson.bin === 'object' &&
          !Array.isArray(packageJson.bin)
        ? (packageJson.bin as Record<string, unknown>)['pi-acp']
        : undefined;
  if (typeof bin !== 'string' || bin.trim() === '') {
    throw new Error('upstream pi-acp does not declare its pi-acp bin');
  }

  const entrypoint = resolve(packageDirectory, bin);
  const relativeEntrypoint = relative(packageDirectory, entrypoint);
  if (
    !isAbsolute(entrypoint) ||
    relativeEntrypoint === '..' ||
    relativeEntrypoint.startsWith(`..${sep}`)
  ) {
    throw new Error('upstream pi-acp declares an invalid bin path');
  }
  return entrypoint;
}

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

  await import(pathToFileURL(resolveUpstreamPiAcpEntrypoint()).href);
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[acp] builtin Pi wrapper failed: ${detail}\n`);
  process.exitCode = 1;
}
