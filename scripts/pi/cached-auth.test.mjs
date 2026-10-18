import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  readlink,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  pidNamespaceIdentity,
  processStartIdentity as helperProcessStartIdentity,
  processState,
  requirePidNamespaceIdentity,
} from './cached-auth.mjs';

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

async function exitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => child.kill('SIGKILL'));
    child.once('close', () => resolve(child.pid));
  });
}

async function installOwnerLock(cacheDir, options = {}) {
  const id = options.id ?? randomBytes(16).toString('hex');
  const ownerName = `.lock-owner-${id}`;
  const ownerPath = join(cacheDir, ownerName);
  const lockPath = join(cacheDir, '.lock.d');
  const owner = {
    version: 2,
    id,
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? hostname(),
    processStartIdentity:
      options.processStartIdentity ??
      helperProcessStartIdentity(options.pid ?? process.pid) ??
      null,
    pidNamespaceIdentity: Object.prototype.hasOwnProperty.call(
      options,
      'pidNamespaceIdentity',
    )
      ? options.pidNamespaceIdentity
      : pidNamespaceIdentity() ?? null,
  };
  await mkdir(ownerPath);
  await writeFile(join(ownerPath, 'owner.json'), `${JSON.stringify(owner)}\n`);
  await symlink(
    process.platform === 'win32' ? ownerPath : ownerName,
    lockPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return { id, ownerName, ownerPath, lockPath };
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
  let ownerOptions = {};
  if (process.platform === 'linux') {
    const legacyIdentity = spawnSync(
      'ps',
      ['-p', String(process.pid), '-o', 'lstart='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    ownerOptions = {
      processStartIdentity:
        !legacyIdentity.error && legacyIdentity.status === 0
          ? legacyIdentity.stdout.trim().replace(/\s+/gu, ' ')
          : 'legacy-identity-unavailable',
    };
  }
  const ownerLock = await installOwnerLock(cacheDir, ownerOptions);

  let clearSettled = false;
  const clear = runAsync(
    cacheDir,
    [process.execPath, '-e', 'process.exit(9)'],
    true,
  ).then((result) => {
    clearSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(clearSettled, false);
  assert.equal(await readlink(ownerLock.lockPath), ownerLock.ownerName);
  assert.equal((await lstat(ownerLock.ownerPath)).isDirectory(), true);
  await unlink(ownerLock.lockPath);
  await rm(ownerLock.ownerPath, { recursive: true });
  const result = await clear;

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(join(cacheDir, 'default.token')));
  await assert.rejects(readFile(join(cacheDir, 'default.meta')));
});

test('Linux owner PIDs are not inspected across missing or different PID namespaces', () => {
  let pidChecks = 0;
  const checkOptions = {
    platform: 'linux',
    currentHost: 'shared-host',
    killProcess: () => {
      pidChecks += 1;
    },
    getProcessStartIdentity: () => 'start-identity',
  };

  assert.equal(
    processState(
      412,
      'shared-host',
      'start-identity',
      'pid:[4026531840]',
      { ...checkOptions, currentPidNamespaceIdentity: 'pid:[4026532000]' },
    ),
    'unknown',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'start-identity',
      undefined,
      { ...checkOptions, currentPidNamespaceIdentity: 'pid:[4026531840]' },
    ),
    'unknown',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'start-identity',
      'pid:[4026531840]',
      { ...checkOptions, currentPidNamespaceIdentity: undefined },
    ),
    'unknown',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'start-identity',
      'pid:[4026531840]',
      { ...checkOptions, currentPidNamespaceIdentity: 'unreadable' },
    ),
    'unknown',
  );
  assert.equal(pidChecks, 0);
  assert.throws(
    () => requirePidNamespaceIdentity(undefined, 'linux'),
    /cannot determine the current Linux PID namespace/,
  );
  assert.equal(
    requirePidNamespaceIdentity('pid:[4026531840]', 'linux'),
    'pid:[4026531840]',
  );
  assert.equal(requirePidNamespaceIdentity(undefined, 'darwin'), null);
});

test('Linux process start identity uses proc stat ticks only through a matching PID namespace', () => {
  let statReads = 0;
  const fields = Array.from({ length: 20 }, (_, index) =>
    index === 0 ? 'S' : index === 19 ? '987654' : String(index),
  );
  const stat = `412 (worker name (with parens)) ${fields.join(' ')}\n`;
  const readStat = (path) => {
    statReads += 1;
    assert.equal(path, '/proc/412/stat');
    return stat;
  };

  assert.equal(
    helperProcessStartIdentity(412, {
      platform: 'linux',
      currentPidNamespaceIdentity: 'pid:[4026531840]',
      procfsPidNamespaceIdentity: 'pid:[4026532000]',
      readFileSync: readStat,
    }),
    undefined,
  );
  assert.equal(statReads, 0);
  assert.equal(
    helperProcessStartIdentity(412, {
      platform: 'linux',
      currentPidNamespaceIdentity: 'pid:[4026531840]',
      procfsPidNamespaceIdentity: undefined,
      readFileSync: readStat,
    }),
    undefined,
  );
  assert.equal(statReads, 0);
  assert.equal(
    helperProcessStartIdentity(412, {
      platform: 'linux',
      currentPidNamespaceIdentity: 'pid:[4026531840]',
      procfsPidNamespaceIdentity: 'pid:[4026531840]',
      readFileSync: readStat,
    }),
    'linux:987654',
  );
  assert.equal(statReads, 1);
  assert.equal(
    helperProcessStartIdentity(413, {
      platform: 'linux',
      currentPidNamespaceIdentity: 'pid:[4026531840]',
      procfsPidNamespaceIdentity: 'pid:[4026531840]',
      readFileSync: readStat,
    }),
    undefined,
  );
  assert.equal(statReads, 2);
});

test(
  'reads the current Linux PID namespace identity',
  { skip: process.platform !== 'linux' },
  () => {
    assert.match(pidNamespaceIdentity(), /^pid:\[\d+\]$/u);
  },
);

test('Linux locks are classified as live or stale only within the same PID namespace', () => {
  const sharedOptions = {
    platform: 'linux',
    currentHost: 'shared-host',
    currentPidNamespaceIdentity: 'pid:[4026531840]',
    getProcessStartIdentity: () => 'start-identity',
  };

  assert.equal(
    processState(
      412,
      'shared-host',
      'start-identity',
      'pid:[4026531840]',
      { ...sharedOptions, killProcess: () => {} },
    ),
    'live',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'start-identity',
      'pid:[4026531840]',
      {
        ...sharedOptions,
        killProcess: () => {
          const error = new Error('process does not exist');
          error.code = 'ESRCH';
          throw error;
        },
      },
    ),
    'dead',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'linux:1234',
      'pid:[4026531840]',
      {
        ...sharedOptions,
        killProcess: () => {},
        getProcessStartIdentity: () => 'linux:5678',
      },
    ),
    'dead',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'linux:1234',
      'pid:[4026531840]',
      {
        ...sharedOptions,
        killProcess: () => {},
        getProcessStartIdentity: () => undefined,
      },
    ),
    'live',
  );

  const legacyStartIdentity = 'Thu Oct 17 05:34:54 2026';
  const legacyOptions = {
    platform: 'linux',
    currentHost: 'shared-host',
    currentPidNamespaceIdentity: 'pid:[4026531840]',
    procfsPidNamespaceIdentity: 'pid:[4026531840]',
    killProcess: () => {},
    spawnSync: () => ({
      status: 0,
      stdout: `${legacyStartIdentity}\n`,
    }),
  };
  assert.equal(
    processState(
      412,
      'shared-host',
      legacyStartIdentity,
      'pid:[4026531840]',
      legacyOptions,
    ),
    'live',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      legacyStartIdentity,
      'pid:[4026531840]',
      {
        ...legacyOptions,
        spawnSync: () => ({
          status: 0,
          stdout: 'Thu Oct 17 05:34:55 2026\n',
        }),
      },
    ),
    'dead',
  );
  assert.equal(
    processState(
      412,
      'shared-host',
      'linux:invalid',
      'pid:[4026531840]',
      { ...legacyOptions, killProcess: () => assert.fail('must not probe PID') },
    ),
    'unknown',
  );
});

test('a matching Darwin start identity is treated as live on second-granularity PID reuse', () => {
  const secondGranularityIdentity = 'Thu Oct 17 05:34:54 2026';
  assert.equal(
    processState(
      412,
      'mac-host',
      secondGranularityIdentity,
      undefined,
      {
        platform: 'darwin',
        currentHost: 'mac-host',
        killProcess: () => {},
        getProcessStartIdentity: () => secondGranularityIdentity,
      },
    ),
    'live',
  );
});

test('fails closed for Linux owner symlinks with missing or different namespace identity', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentNamespace = pidNamespaceIdentity();
  assert.match(currentNamespace ?? '', /^pid:\[\d+\]$/u);
  const differentNamespace =
    currentNamespace === 'pid:[1]' ? 'pid:[2]' : 'pid:[1]';

  for (const [label, namespace] of [
    ['missing', null],
    ['different', differentNamespace],
  ]) {
    const cacheDir = join(root, label);
    const marker = join(root, `${label}-credential-runs`);
    await mkdir(cacheDir);
    const ownerLock = await installOwnerLock(cacheDir, {
      pidNamespaceIdentity: namespace,
    });
    const result = run(cacheDir, markerCommand(marker, 'must-not-run'));

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /PID namespace is missing, inaccessible, or different/u);
    assert.equal(await readlink(ownerLock.lockPath), ownerLock.ownerName);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});

test('recovers orphan locks and serializes six concurrent misses over repeated rounds', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const rounds = process.platform === 'linux' ? 8 : 1;

  for (let round = 0; round < rounds; round += 1) {
    const cacheDir = join(root, `cache-${round}`);
    const marker = join(root, `runs-${round}`);
    await mkdir(cacheDir);
    const deadOwnerPid = await exitedPid();
    const ownerLock = await installOwnerLock(cacheDir, {
      pid: deadOwnerPid,
    });

    const command = markerCommand(marker, 'recovered-token', 100);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runAsync(cacheDir, command)),
    );
    const diagnostics = results
      .map(
        ({ status, stdout, stderr }, index) =>
          `round ${round} worker ${index}: exit=${status}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}`,
      )
      .join('\n');

    assert.deepEqual(
      results.map((result) => [result.status, result.stdout]),
      Array.from({ length: 6 }, () => [0, 'recovered-token']),
      diagnostics,
    );
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(lstat(ownerLock.lockPath));
  }
});

test('recovers a lock interrupted after its owner directory was claimed during recovery', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  await mkdir(cacheDir);
  const deadRecoveryPid = await exitedPid();
  const id = randomBytes(16).toString('hex');
  const ownerName = `.lock-owner-${id}`;
  const hostHex = Buffer.from(hostname()).toString('hex');
  const ownerPidNamespaceIdentity = pidNamespaceIdentity();
  const pidNamespaceHex = ownerPidNamespaceIdentity
    ? Buffer.from(ownerPidNamespaceIdentity).toString('hex')
    : '0';
  const nonce = randomBytes(16).toString('hex');
  const recoveryName = `.lock-recovery-${id}-${hostHex}-${deadRecoveryPid}-0-${pidNamespaceHex}-${nonce}`;
  await mkdir(join(cacheDir, recoveryName));
  await symlink(
    process.platform === 'win32'
      ? join(cacheDir, ownerName)
      : ownerName,
    join(cacheDir, '.lock.d'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(cacheDir, 'default.token'), 'cached-token');
  await writeFile(join(cacheDir, 'default.meta'), `${Date.now()}\n`);

  const result = run(
    cacheDir,
    [process.execPath, '-e', 'process.exit(9)'],
    { clear: true },
  );

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(join(cacheDir, 'default.token')));
  await assert.rejects(readFile(join(cacheDir, 'default.meta')));
  await assert.rejects(lstat(join(cacheDir, '.lock.d')));
});

test('fails fast without removing an ownerless legacy lock', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  const lockPath = join(cacheDir, '.lock.d');
  await mkdir(cacheDir);
  await mkdir(lockPath);

  const result = run(cacheDir, markerCommand(join(root, 'runs'), 'token'));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ownerless format/);
  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

test('fails closed after bounded retries for a stable owner symlink without metadata', async (t) => {
  const root = await makeTempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, 'cache');
  const lockPath = join(cacheDir, '.lock.d');
  const ownerName = `.lock-owner-${randomBytes(16).toString('hex')}`;
  const ownerPath = join(cacheDir, ownerName);
  const marker = join(root, 'credential-runs');
  await mkdir(cacheDir);
  await mkdir(ownerPath);
  await symlink(ownerName, lockPath, 'dir');

  const result = run(cacheDir, markerCommand(marker, 'must-not-run'));

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /owner record is missing/u);
  assert.equal(await readlink(lockPath), ownerName);
  assert.equal((await lstat(ownerPath)).isDirectory(), true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
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
      results
        .map(({ status, stderr }, index) => `worker ${index}: exit=${status}, stderr=${stderr}`)
        .join('\n'),
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
