import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('./cached-auth.mjs', import.meta.url));
const markerProgram = `
  const fs = require('node:fs');
  fs.appendFileSync(process.argv[1], 'run\\n');
  process.stdout.write(process.argv[2]);
  if (Number(process.argv[3]) > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
      Number(process.argv[3]));
  }
`;

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'ensemble-cached-auth-'));
}

function run(cacheDir, command, options = {}) {
  const args = [
    scriptPath,
    '--cache-dir',
    cacheDir,
    ...(options.cacheKey ? ['--cache-key', options.cacheKey] : []),
    ...(options.ttlMs !== undefined ? ['--ttl-ms', String(options.ttlMs)] : []),
    ...(options.clear ? ['--clear'] : []),
    '--',
    ...command,
  ];
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
}

function runAsync(cacheDir, command, clear = false, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        '--cache-dir',
        cacheDir,
        ...(clear ? ['--clear'] : []),
        '--',
        ...command,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (onSpawn) child.once('spawn', onSpawn);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function markerCommand(marker, output, delayMs = 0) {
  return [process.execPath, '-e', markerProgram, marker, output, String(delayMs)];
}

test('reads an existing default-key .token/.meta entry without running the command', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  await mkdir(cacheDir);
  await writeFile(join(cacheDir, 'default.token'), 'legacy-token');
  await writeFile(join(cacheDir, 'default.meta'), `${Date.now()}\n`);
  const marker = join(root, 'should-not-run');

  const result = run(cacheDir, markerCommand(marker, 'new-token'), {
    ttlMs: 300_000,
    env: { ENSEMBLE_PI_AUTH_CACHE_TTL_MS: 'invalid-but-overridden' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'legacy-token');
  await assert.rejects(readFile(marker));
});

test('runs a miss command and atomically saves its normalized stdout and metadata', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  const marker = join(root, 'runs');

  const result = run(cacheDir, markerCommand(marker, 'fresh-token\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fresh-token');
  assert.equal(await readFile(join(cacheDir, 'default.token'), 'utf8'), 'fresh-token');
  assert.match(await readFile(join(cacheDir, 'default.meta'), 'utf8'), /^\d+\n$/);
  assert.equal((await stat(join(cacheDir, 'default.token'))).mode & 0o777, 0o600);
  assert.equal(await readFile(marker, 'utf8'), 'run\n');
});

test('applies TTL expiry and reuses a still-valid JWT without a Python helper', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  const marker = join(root, 'runs');
  await mkdir(cacheDir);
  const jwt = `header.${Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
  ).toString('base64url')}.signature`;
  await writeFile(join(cacheDir, 'default.token'), jwt);
  await writeFile(join(cacheDir, 'default.meta'), `${Date.now() - 60_000}\n`);

  const jwtHit = run(cacheDir, markerCommand(marker, 'wrong-token'), { ttlMs: 0 });
  assert.equal(jwtHit.status, 0, jwtHit.stderr);
  assert.equal(jwtHit.stdout, jwt);
  await assert.rejects(readFile(marker));

  await writeFile(join(cacheDir, 'default.token'), 'opaque-token');
  const expiredTtl = run(cacheDir, markerCommand(marker, 'refreshed-token'), {
    ttlMs: 1,
  });
  assert.equal(expiredTtl.status, 0, expiredTtl.stderr);
  assert.equal(expiredTtl.stdout, 'refreshed-token');
  assert.equal(await readFile(marker, 'utf8'), 'run\n');
});

test('separates cache keys and --clear removes only the selected key', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  const marker = join(root, 'runs');

  const firstA = run(cacheDir, markerCommand(marker, 'token-a'), { cacheKey: 'account-a' });
  const firstB = run(cacheDir, markerCommand(marker, 'token-b'), { cacheKey: 'account-b' });
  assert.equal(firstA.status, 0, firstA.stderr);
  assert.equal(firstB.status, 0, firstB.stderr);
  assert.equal(firstA.stdout, 'token-a');
  assert.equal(firstB.stdout, 'token-b');

  const clearA = run(
    cacheDir,
    markerCommand(marker, 'token-a-refreshed'),
    { cacheKey: 'account-a', clear: true },
  );
  assert.equal(clearA.status, 0, clearA.stderr);
  const hitB = run(cacheDir, markerCommand(marker, 'wrong-token'), { cacheKey: 'account-b' });
  const refreshA = run(cacheDir, markerCommand(marker, 'token-a-refreshed'), {
    cacheKey: 'account-a',
  });

  assert.equal(hitB.stdout, 'token-b');
  assert.equal(refreshA.stdout, 'token-a-refreshed');
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 3);
});

test('--clear waits for the refresh lock instead of treating the cache as a hit', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  await mkdir(cacheDir);
  await writeFile(join(cacheDir, 'default.token'), 'cached-token');
  await writeFile(join(cacheDir, 'default.meta'), `${Date.now()}\n`);
  const lockPath = join(cacheDir, '.lock.d');
  await mkdir(lockPath);

  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const clear = runAsync(
    cacheDir,
    [process.execPath, '-e', 'process.exit(9)'],
    true,
    markSpawned,
  );
  await spawned;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(lockPath, { recursive: true });
  const result = await clear;

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(join(cacheDir, 'default.token')));
  await assert.rejects(readFile(join(cacheDir, 'default.meta')));
});

test('serializes concurrent misses and ignores the legacy .lock file/directory path', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const legacyLockType of ['file', 'directory']) {
    const cacheDir = join(root, legacyLockType);
    const marker = join(root, `${legacyLockType}-runs`);
    await mkdir(cacheDir);
    // Linux bash/flock left a file; macOS bash/mkdir left a directory.
    if (legacyLockType === 'file') {
      await writeFile(join(cacheDir, '.lock'), 'legacy lock file');
    } else {
      await mkdir(join(cacheDir, '.lock'));
    }

    const command = markerCommand(marker, 'shared-token', 150);
    const children = Array.from({ length: 8 }, () => runAsync(cacheDir, command));
    const results = await Promise.all(children);

    assert.deepEqual(
      results.map((result) => [result.status, result.stdout]),
      Array.from({ length: 8 }, () => [0, 'shared-token']),
    );
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(stat(join(cacheDir, '.lock.d')));
  }
});

test('rejects empty stdout and leaves no cache entry', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');

  const result = run(cacheDir, [process.execPath, '-e', 'process.stdout.write("\\n\\r")']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty stdout/);
  await assert.rejects(readFile(join(cacheDir, 'default.token')));
});
