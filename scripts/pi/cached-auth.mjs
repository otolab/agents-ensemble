#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_TTL_MS = 300_000;
const LOCK_DIR_NAME = '.lock.d';
const LOCK_OWNER_PREFIX = '.lock-owner-';
const LOCK_RECOVERY_PREFIX = '.lock-recovery-';
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

export function processStartIdentity(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') {
    const currentPidNamespaceIdentity = Object.prototype.hasOwnProperty.call(
      options,
      'currentPidNamespaceIdentity',
    )
      ? options.currentPidNamespaceIdentity
      : pidNamespaceIdentity(platform);
    const procfsPidNamespaceIdentity = Object.prototype.hasOwnProperty.call(
      options,
      'procfsPidNamespaceIdentity',
    )
      ? options.procfsPidNamespaceIdentity
      : pidNamespaceIdentityForProcfs(platform);
    if (
      typeof currentPidNamespaceIdentity !== 'string' ||
      typeof procfsPidNamespaceIdentity !== 'string' ||
      currentPidNamespaceIdentity !== procfsPidNamespaceIdentity
    ) {
      return undefined;
    }
  }

  const result = (options.spawnSync ?? spawnSync)(
    'ps',
    ['-p', String(pid), '-o', 'lstart='],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (result.error || result.status !== 0) return undefined;
  const identity = result.stdout.trim().replace(/\s+/gu, ' ');
  return identity || undefined;
}

export function pidNamespaceIdentity(platform = process.platform) {
  if (platform !== 'linux') return undefined;
  try {
    const identity = readlinkSync('/proc/self/ns/pid');
    return /^pid:\[\d+\]$/u.test(identity) ? identity : undefined;
  } catch {
    return undefined;
  }
}

function pidNamespaceIdentityForProcfs(platform = process.platform) {
  if (platform !== 'linux') return undefined;
  try {
    const identity = readlinkSync('/proc/1/ns/pid');
    return /^pid:\[\d+\]$/u.test(identity) ? identity : undefined;
  } catch {
    return undefined;
  }
}

export function requirePidNamespaceIdentity(
  identity,
  platform = process.platform,
) {
  if (
    platform === 'linux' &&
    (typeof identity !== 'string' || !/^pid:\[\d+\]$/u.test(identity))
  ) {
    throw new Error(
      'cannot determine the current Linux PID namespace; refusing to use the cache lock',
    );
  }
  return identity ?? null;
}

export function processState(
  pid,
  processHost,
  expectedStartIdentity,
  expectedPidNamespaceIdentity,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const currentHost = options.currentHost ?? hostname();
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  if (processHost !== currentHost) return 'unknown';

  if (platform === 'linux') {
    const hasInjectedNamespace = Object.prototype.hasOwnProperty.call(
      options,
      'currentPidNamespaceIdentity',
    );
    const currentPidNamespaceIdentity = hasInjectedNamespace
      ? options.currentPidNamespaceIdentity
      : pidNamespaceIdentity(platform);
    if (
      typeof expectedPidNamespaceIdentity !== 'string' ||
      !/^pid:\[\d+\]$/u.test(expectedPidNamespaceIdentity) ||
      typeof currentPidNamespaceIdentity !== 'string' ||
      !/^pid:\[\d+\]$/u.test(currentPidNamespaceIdentity) ||
      currentPidNamespaceIdentity !== expectedPidNamespaceIdentity
    ) {
      return 'unknown';
    }
  }

  try {
    (options.killProcess ?? ((targetPid) => process.kill(targetPid, 0)))(pid);
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code !== 'EPERM') return 'unknown';
  }

  if (typeof expectedStartIdentity !== 'string' || expectedStartIdentity.length === 0) {
    return 'live';
  }
  const actualStartIdentity = (
    options.getProcessStartIdentity ?? processStartIdentity
  )(pid);
  if (actualStartIdentity === undefined) {
    try {
      (options.killProcess ?? ((targetPid) => process.kill(targetPid, 0)))(pid);
      return 'live';
    } catch (error) {
      return error?.code === 'ESRCH' ? 'dead' : 'live';
    }
  }
  return actualStartIdentity === expectedStartIdentity ? 'live' : 'dead';
}

function ownerDirectoryName(ownerId) {
  return `${LOCK_OWNER_PREFIX}${ownerId}`;
}

function parseOwnerDirectoryName(name) {
  const match = /^\.lock-owner-([a-f0-9]{32})$/u.exec(name);
  return match?.[1];
}

function recoveryDirectoryName(ownerId, reaper) {
  const hostHex = Buffer.from(reaper.hostname).toString('hex');
  const startHex = reaper.processStartIdentity
    ? Buffer.from(reaper.processStartIdentity).toString('hex')
    : '0';
  const pidNamespaceHex = reaper.pidNamespaceIdentity
    ? Buffer.from(reaper.pidNamespaceIdentity).toString('hex')
    : '0';
  const nonce = randomBytes(16).toString('hex');
  return `${LOCK_RECOVERY_PREFIX}${ownerId}-${hostHex}-${reaper.pid}-${startHex}-${pidNamespaceHex}-${nonce}`;
}

function parseRecoveryDirectoryName(name, ownerId) {
  const prefix = `${LOCK_RECOVERY_PREFIX}${ownerId}-`;
  if (!name.startsWith(prefix)) return undefined;
  const encoded = name.slice(prefix.length);
  const currentFormat =
    /^([a-f0-9]+)-(\d+)-([a-f0-9]+)-([a-f0-9]+)-([a-f0-9]{32})$/u.exec(encoded);
  const previousFormat =
    /^([a-f0-9]+)-(\d+)-([a-f0-9]+)-([a-f0-9]{32})$/u.exec(encoded);
  const match = currentFormat ?? previousFormat;
  if (!match) return undefined;

  let processHost;
  let processStart;
  let processPidNamespace;
  try {
    processHost = Buffer.from(match[1], 'hex').toString('utf8');
    processStart =
      match[3] === '0'
        ? undefined
        : Buffer.from(match[3], 'hex').toString('utf8');
    const namespaceHex = currentFormat ? match[4] : undefined;
    processPidNamespace =
      namespaceHex === undefined || namespaceHex === '0'
        ? undefined
        : Buffer.from(namespaceHex, 'hex').toString('utf8');
  } catch {
    return undefined;
  }
  if (
    processPidNamespace !== undefined &&
    !/^pid:\[\d+\]$/u.test(processPidNamespace)
  ) {
    return undefined;
  }
  return {
    pid: Number(match[2]),
    hostname: processHost,
    processStartIdentity: processStart,
    pidNamespaceIdentity: processPidNamespace,
  };
}

function readLockTarget(cacheDir, lockPath) {
  let lockStat;
  try {
    lockStat = lstatSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'free' };
    throw error;
  }
  if (!lockStat.isSymbolicLink()) {
    return {
      state: 'unknown',
      reason: 'the lock is in the ownerless format used by an older helper',
    };
  }

  let target;
  try {
    target = readlinkSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'free' };
    throw error;
  }
  const targetPath = resolve(dirname(lockPath), target);
  if (dirname(targetPath) !== resolve(cacheDir)) {
    return { state: 'unknown', reason: 'the lock target is outside the cache directory' };
  }

  const ownerId = parseOwnerDirectoryName(basename(targetPath));
  if (!ownerId) {
    return { state: 'unknown', reason: 'the lock owner identity is invalid' };
  }
  return {
    state: 'owned',
    ownerId,
    ownerDirectoryName: basename(targetPath),
    ownerDirectoryPath: targetPath,
  };
}

function readOwner(ownerDirectoryPath, expectedId) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(ownerDirectoryPath, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (
    ![1, 2].includes(owner?.version) ||
    owner.id !== expectedId ||
    !Number.isSafeInteger(owner.pid) ||
    typeof owner.hostname !== 'string' ||
    (owner.processStartIdentity !== null &&
      typeof owner.processStartIdentity !== 'string') ||
    (owner.version === 2 &&
      (owner.pidNamespaceIdentity !== null &&
        (typeof owner.pidNamespaceIdentity !== 'string' ||
          !/^pid:\[\d+\]$/u.test(owner.pidNamespaceIdentity))))
  ) {
    return undefined;
  }
  return owner;
}

function recoveryCandidates(cacheDir, ownerId) {
  return readdirSync(cacheDir)
    .map((name) => ({
      name,
      process: parseRecoveryDirectoryName(name, ownerId),
    }))
    .filter((candidate) => candidate.process !== undefined);
}

function inspectExistingLock(cacheDir, lockPath, currentPidNamespaceIdentity) {
  const target = readLockTarget(cacheDir, lockPath);
  if (target.state !== 'owned') return target;

  const owner = readOwner(target.ownerDirectoryPath, target.ownerId);
  if (owner) {
    if (
      process.platform === 'linux' &&
      (typeof currentPidNamespaceIdentity !== 'string' ||
        typeof owner.pidNamespaceIdentity !== 'string' ||
        owner.pidNamespaceIdentity !== currentPidNamespaceIdentity)
    ) {
      return {
        ...target,
        state: 'unknown',
        reason: 'the lock PID namespace is missing, inaccessible, or different',
      };
    }
    const state = processState(
      owner.pid,
      owner.hostname,
      owner.processStartIdentity,
      owner.pidNamespaceIdentity,
      { currentPidNamespaceIdentity },
    );
    if (state === 'dead') return { ...target, state: 'stale-owner' };
    if (state === 'live') return { ...target, state: 'live' };
    return { ...target, state: 'unknown', reason: 'the lock owner cannot be verified' };
  }

  const candidates = recoveryCandidates(cacheDir, target.ownerId);
  if (candidates.length === 0) {
    return {
      ...target,
      state: 'unknown',
      reason: 'the lock owner record is missing',
    };
  }

  let staleRecovery;
  for (const candidate of candidates) {
    const state = processState(
      candidate.process.pid,
      candidate.process.hostname,
      candidate.process.processStartIdentity,
      candidate.process.pidNamespaceIdentity,
      { currentPidNamespaceIdentity },
    );
    if (state === 'live') return { ...target, state: 'live' };
    if (state === 'unknown') {
      return {
        ...target,
        state: 'unknown',
        reason: 'the interrupted lock recovery owner cannot be verified',
      };
    }
    staleRecovery = candidate;
  }
  return { ...target, state: 'stale-recovery', recovery: staleRecovery };
}

function createOwnedLock(cacheDir, lockPath, currentPidNamespaceIdentity) {
  const recordedPidNamespaceIdentity = requirePidNamespaceIdentity(
    currentPidNamespaceIdentity,
  );
  const id = randomBytes(16).toString('hex');
  const ownerName = ownerDirectoryName(id);
  const ownerPath = resolve(cacheDir, ownerName);
  const owner = {
    version: 2,
    id,
    pid: process.pid,
    hostname: hostname(),
    processStartIdentity: processStartIdentity(process.pid) ?? null,
    pidNamespaceIdentity: recordedPidNamespaceIdentity,
  };

  mkdirSync(ownerPath, { mode: 0o700 });
  let published = false;
  try {
    writeFileSync(join(ownerPath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    const linkTarget =
      process.platform === 'win32' ? ownerPath : ownerName;
    symlinkSync(linkTarget, lockPath, process.platform === 'win32' ? 'junction' : 'dir');
    published = true;
    return { id, ownerName, ownerPath, lockPath };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return undefined;
  } finally {
    if (!published) rmSync(ownerPath, { recursive: true, force: true });
  }
}

function lockLinkPointsTo(lockPath, ownerDirectoryPath) {
  try {
    return resolve(dirname(lockPath), readlinkSync(lockPath)) === ownerDirectoryPath;
  } catch {
    return false;
  }
}

function claimRecoveryDirectory(
  cacheDir,
  ownerId,
  sourcePath,
  currentPidNamespaceIdentity,
) {
  const reaper = {
    pid: process.pid,
    hostname: hostname(),
    processStartIdentity: processStartIdentity(process.pid),
    pidNamespaceIdentity: currentPidNamespaceIdentity,
  };
  const recoveryPath = join(
    cacheDir,
    recoveryDirectoryName(ownerId, reaper),
  );
  try {
    renameSync(sourcePath, recoveryPath);
    return recoveryPath;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return undefined;
    throw error;
  }
}

function reclaimStaleLock(
  cacheDir,
  lockPath,
  lock,
  currentPidNamespaceIdentity,
) {
  const sourcePath =
    lock.state === 'stale-owner'
      ? lock.ownerDirectoryPath
      : join(cacheDir, lock.recovery.name);
  const recoveryPath = claimRecoveryDirectory(
    cacheDir,
    lock.ownerId,
    sourcePath,
    currentPidNamespaceIdentity,
  );
  if (!recoveryPath) return false;

  if (lockLinkPointsTo(lockPath, lock.ownerDirectoryPath)) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  rmSync(recoveryPath, { recursive: true, force: true });
  return true;
}

function releaseLock(lock) {
  if (lockLinkPointsTo(lock.lockPath, lock.ownerPath)) {
    try {
      unlinkSync(lock.lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  rmSync(lock.ownerPath, { recursive: true, force: true });
}

function withLock(cacheDir, paths, ttlMs, command, action) {
  const lockPath = join(cacheDir, LOCK_DIR_NAME);
  const currentPidNamespaceIdentity = pidNamespaceIdentity();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lock;
  while (true) {
    try {
      lock = createOwnedLock(
        cacheDir,
        lockPath,
        currentPidNamespaceIdentity,
      );
      if (lock) break;
    } catch (error) {
      throw error;
    }

    if (action !== 'clear') {
      const cachedToken = readValidToken(paths, ttlMs);
      if (cachedToken !== undefined) return cachedToken;
    }

    const existingLock = inspectExistingLock(
      cacheDir,
      lockPath,
      currentPidNamespaceIdentity,
    );
    if (existingLock.state === 'stale-owner' || existingLock.state === 'stale-recovery') {
      if (
        reclaimStaleLock(
          cacheDir,
          lockPath,
          existingLock,
          currentPidNamespaceIdentity,
        )
      ) continue;
    } else if (existingLock.state === 'unknown') {
      throw new Error(
        `cache lock owner cannot be verified (${existingLock.reason}); refusing to remove it`,
      );
    } else if (existingLock.state === 'free') {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error('could not acquire cache lock');
    }
    Atomics.wait(SLEEP_CELL, 0, 0, LOCK_POLL_MS);
  }

  try {
    if (action === 'clear') {
      rmSync(paths.token, { force: true });
      rmSync(paths.meta, { force: true });
      return '';
    }
    return refresh(paths, ttlMs, command);
  } finally {
    releaseLock(lock);
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

function isDirectInvocation() {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) main();
