#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 300_000;
const LOCK_DIR_NAME = '.lock.d';
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 25;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function usage() {
  return `Usage: cached-auth.mjs [options] -- <command> [args...]

Options:
  --cache-dir PATH   Cache directory (default: ~/.ensemble/pi/cache/auth or $ENSEMBLE_PI_AUTH_CACHE_DIR)
  --ttl-ms MS        Minimum interval before re-running <command> (default: 300000)
  --cache-key KEY    Cache file basename (default: default)
  --clear            Delete cache entry for this key and exit
  -h, --help         Show this help

Environment:
  ENSEMBLE_PI_AUTH_CACHE_DIR      Default --cache-dir
  ENSEMBLE_PI_AUTH_CACHE_TTL_MS   Default --ttl-ms

Example (models.json):
  "apiKey": "!/absolute/path/to/agents-ensemble/scripts/pi/cached-auth.mjs --ttl-ms 300000 -- gcloud auth print-identity-token --account=you@example.com"
`;
}

function parseOptions(args, env) {
  const options = {
    cacheDir:
      env.ENSEMBLE_PI_AUTH_CACHE_DIR ||
      join(homedir(), '.ensemble', 'pi', 'cache', 'auth'),
    ttlValue: env.ENSEMBLE_PI_AUTH_CACHE_TTL_MS || String(DEFAULT_TTL_MS),
    cacheKey: 'default',
    clear: false,
    command: [],
  };

  for (let index = 0; index < args.length; ) {
    const arg = args[index];
    if (arg === '--') {
      options.command = args.slice(index + 1);
      break;
    }
    if (arg === '-h' || arg === '--help') {
      return { ...options, help: true };
    }
    if (arg === '--clear') {
      options.clear = true;
      index += 1;
      continue;
    }
    if (arg === '--cache-dir' || arg === '--ttl-ms' || arg === '--cache-key') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new UsageError(`missing value for ${arg}`);
      }
      if (arg === '--cache-dir') options.cacheDir = value;
      if (arg === '--ttl-ms') options.ttlValue = value;
      if (arg === '--cache-key') options.cacheKey = value;
      index += 2;
      continue;
    }
    throw new UsageError(`unknown option: ${arg}`);
  }

  if (options.command.length === 0) {
    throw new UsageError('missing command after --');
  }
  options.ttlMs = parseTtl(options.ttlValue);
  delete options.ttlValue;
  if (
    options.cacheKey.length === 0 ||
    basename(options.cacheKey) !== options.cacheKey ||
    options.cacheKey.includes('/') ||
    options.cacheKey.includes('\\') ||
    options.cacheKey === '.' ||
    options.cacheKey === '..'
  ) {
    throw new UsageError('--cache-key must be a non-empty file basename');
  }
  if (!options.cacheDir) {
    throw new UsageError('--cache-dir must not be empty');
  }
  return options;
}

function parseTtl(value) {
  if (!/^\d+$/.test(value)) {
    throw new UsageError('--ttl-ms must be a non-negative integer');
  }
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs)) {
    throw new UsageError('--ttl-ms must be a non-negative integer');
  }
  return ttlMs;
}

class UsageError extends Error {}

function cachePaths(cacheDir, cacheKey) {
  return {
    token: join(cacheDir, `${cacheKey}.token`),
    meta: join(cacheDir, `${cacheKey}.meta`),
  };
}

function readValidToken(paths, ttlMs, nowMs = Date.now()) {
  let token;
  let fetchedAtMs;
  try {
    token = readFileSync(paths.token, 'utf8');
    fetchedAtMs = Number(readFileSync(paths.meta, 'utf8').trim());
  } catch {
    return undefined;
  }
  if (!Number.isFinite(fetchedAtMs)) return undefined;

  if (ttlMs > 0 && nowMs - fetchedAtMs < ttlMs) return token;

  const exp = jwtExpirationSeconds(token);
  if (exp !== undefined && exp > Math.floor(nowMs / 1_000) + 300) {
    return token;
  }
  return undefined;
}

function jwtExpirationSeconds(token) {
  try {
    const parts = token.trim().split('.');
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    return Number.isSafeInteger(payload.exp) ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function ensureCacheDir(cacheDir) {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(cacheDir, 0o700);
  } catch {
    // Preserve the previous helper's best-effort permission tightening.
  }
}

function writeAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function refresh(paths, ttlMs, command) {
  const cachedToken = readValidToken(paths, ttlMs);
  if (cachedToken !== undefined) return cachedToken;

  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('inner command failed');
  }

  const token = result.stdout
    .toString('utf8')
    .replace(/[\r\n]/g, '')
    .replace(/\s+$/u, '');
  if (token.length === 0) {
    throw new Error('inner command produced empty stdout');
  }

  writeAtomic(paths.token, token);
  writeAtomic(paths.meta, `${Date.now()}\n`);
  return token;
}

function withLock(cacheDir, paths, ttlMs, command, action) {
  const lockPath = join(cacheDir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (action !== 'clear') {
        const cachedToken = readValidToken(paths, ttlMs);
        if (cachedToken !== undefined) return cachedToken;
      }
      if (Date.now() >= deadline) {
        throw new Error('could not acquire cache lock');
      }
      Atomics.wait(SLEEP_CELL, 0, 0, LOCK_POLL_MS);
    }
  }

  try {
    if (action === 'clear') {
      rmSync(paths.token, { force: true });
      rmSync(paths.meta, { force: true });
      return '';
    }
    return refresh(paths, ttlMs, command);
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`cached-auth.mjs: ${error.message}\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  try {
    ensureCacheDir(options.cacheDir);
    const paths = cachePaths(options.cacheDir, options.cacheKey);
    if (options.clear) {
      withLock(
        options.cacheDir,
        paths,
        options.ttlMs,
        options.command,
        'clear',
      );
      return;
    }

    const cachedToken = readValidToken(paths, options.ttlMs);
    const token =
      cachedToken ??
      withLock(
        options.cacheDir,
        paths,
        options.ttlMs,
        options.command,
        'refresh',
      );
    process.stdout.write(token);
  } catch (error) {
    process.stderr.write(`cached-auth.mjs: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
