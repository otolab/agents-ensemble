import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptPath = fileURLToPath(
  new URL('./remote-ensemble-issue.sh', import.meta.url),
);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => {
      const stateDir = join(path, 'state');
      let stateFiles = [];
      try {
        stateFiles = await readdir(stateDir);
      } catch {}
      await Promise.all(
        stateFiles
          .filter((name) => name.endsWith('.session'))
          .map(async (name) => {
            try {
              const state = JSON.parse(
                await readFile(join(stateDir, name), 'utf8'),
              );
              process.kill(state.pid, 'SIGTERM');
            } catch {}
          }),
      );
      await rm(path, { recursive: true, force: true });
    }),
  );
});

test('quotes remote paths and arguments, then reuses the session without starting twice', async () => {
  const fixture = await createFixture();
  const remoteDir = join(fixture.root, "work tree's repo");
  const remoteDirArgument = `${remoteDir}///`;
  const marker = join(fixture.root, 'should-not-run');
  await mkdir(remoteDir);
  const issueRef = '#687';
  const issueArgs = [
    '--profile',
    'profile with spaces',
    `operator's note; touch ${marker}`,
    `literal $(touch ${marker})`,
  ];

  const firstRun = runScript(
    [remoteDirArgument, issueRef, '--', ...issueArgs],
    fixture.env,
  );
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.match(firstRun.stderr, /tmux session: work-tree-s-repo-687/);
  assert.match(
    firstRun.stderr,
    /Reconnect from a TTY with ENSEMBLE_REMOTE_SSH set by running:/,
  );
  const readyMessageIndex = firstRun.stderr.indexOf('tmux session ready:');
  const reconnectMessageIndex = firstRun.stderr.indexOf('Reconnect from a TTY');
  assert.ok(readyMessageIndex >= 0);
  assert.ok(reconnectMessageIndex > readyMessageIndex);

  const ensembleCalls = await readJsonLines(fixture.ensembleLog);
  assert.deepEqual(ensembleCalls, [
    {
      cwd: await realpath(remoteDir),
      args: ['issue', issueRef, ...issueArgs],
    },
  ]);
  assert.equal(await pathExists(marker), false);

  const sshCalls = await readJsonLines(fixture.sshLog);
  assert.equal(sshCalls.length, 1);
  assert.deepEqual(sshCalls[0].slice(0, -1), [
    '-J',
    'bastion',
    '-T',
    'user@remote',
  ]);
  assert.match(sshCalls[0].at(-1), /work tree.*s repo/);

  const secondRun = runScript(
    [remoteDirArgument, issueRef, '--', ...issueArgs],
    fixture.env,
  );
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.deepEqual(await readJsonLines(fixture.ensembleLog), ensembleCalls);

  const tmuxCalls = await readJsonLines(fixture.tmuxLog);
  assert.ok(
    tmuxCalls.some(
      ([command, flag, target]) =>
        command === 'has-session' &&
        flag === '-t' &&
        target === '=work-tree-s-repo-687',
    ),
  );
  assert.equal(tmuxCalls.filter(([command]) => command === 'new-session').length, 1);
  assert.equal(tmuxCalls.filter(([command]) => command === 'attach-session').length, 0);
});

test('simultaneous invocations create one ensemble process for the same session', async () => {
  const fixture = await createFixture({ startBarrier: 2 });
  const remoteDir = join(fixture.root, 'agents-ensemble');
  await mkdir(remoteDir);

  const results = await Promise.all([
    runScriptAsync([remoteDir, 'https://github.com/otolab/agents-ensemble/issues/687'], fixture.env),
    runScriptAsync([remoteDir, 'https://github.com/otolab/agents-ensemble/issues/687'], fixture.env),
  ]);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }

  assert.equal((await readJsonLines(fixture.ensembleLog)).length, 1);
  assert.equal(
    (await readJsonLines(fixture.tmuxLog)).filter(
      ([command]) => command === 'new-session',
    ).length,
    2,
  );
});

test('fails before tmux when the remote executable is missing or not executable', async () => {
  const fixture = await createFixture();
  const remoteDir = join(fixture.root, 'agents-ensemble');
  await mkdir(remoteDir);
  const missingExecutable = join(fixture.root, 'missing ensemble');
  const nonExecutable = join(fixture.root, 'not executable');
  const missingPathExecutable = 'ensemble-not-in-path';
  await writeFile(nonExecutable, '#!/bin/sh\nexit 0\n', 'utf8');

  for (const executable of [
    missingExecutable,
    nonExecutable,
    missingPathExecutable,
  ]) {
    const result = runScript([remoteDir, '688'], {
      ...fixture.env,
      ENSEMBLE_REMOTE_ENSEMBLE: executable,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote executable not found or not executable/);
    assertNoStartupSuccess(result);
  }
  assert.equal(
    (await readJsonLines(fixture.tmuxLog)).filter(
      ([command]) => command === 'new-session',
    ).length,
    0,
  );
});

test('fails when the tmux pane command exits immediately', async () => {
  const fixture = await createFixture({ ensembleExitsImmediately: true });
  const remoteDir = join(fixture.root, 'agents-ensemble');
  await mkdir(remoteDir);

  const result = runScript([remoteDir, '689'], fixture.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tmux session did not keep a running pane/);
  assertNoStartupSuccess(result);
  assert.equal((await readJsonLines(fixture.ensembleLog)).length, 1);
});

test('fails when an executable file cannot be launched by tmux', async () => {
  const fixture = await createFixture();
  const remoteDir = join(fixture.root, 'agents-ensemble');
  const invalidExecutable = join(fixture.root, 'invalid interpreter');
  await mkdir(remoteDir);
  await writeFile(invalidExecutable, '#!/missing/interpreter\n', 'utf8');
  await chmod(invalidExecutable, 0o755);

  const result = runScript([remoteDir, '690'], {
    ...fixture.env,
    ENSEMBLE_REMOTE_ENSEMBLE: invalidExecutable,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tmux session did not keep a running pane/);
  assertNoStartupSuccess(result);
  assert.equal(
    (await readJsonLines(fixture.tmuxLog)).filter(
      ([command]) => command === 'new-session',
    ).length,
    1,
  );
});

test('fails when tmux reports that the session pane is dead', async () => {
  const fixture = await createFixture({ paneDead: true });
  const remoteDir = join(fixture.root, 'agents-ensemble');
  await mkdir(remoteDir);

  const result = runScript([remoteDir, '692'], fixture.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tmux session did not keep a running pane/);
  assertNoStartupSuccess(result);
  assert.equal((await readJsonLines(fixture.ensembleLog)).length, 1);
});

test('concurrent callers report an immediately exiting pane as failed', async () => {
  const fixture = await createFixture({
    startBarrier: 2,
    ensembleExitsImmediately: true,
  });
  const remoteDir = join(fixture.root, 'agents-ensemble');
  await mkdir(remoteDir);

  const results = await Promise.all([
    runScriptAsync([remoteDir, '691'], fixture.env),
    runScriptAsync([remoteDir, '691'], fixture.env),
  ]);

  for (const result of results) {
    assert.notEqual(result.status, 0);
    assertNoStartupSuccess(result);
  }
  assert.ok((await readJsonLines(fixture.ensembleLog)).length >= 1);
});

test('missing SSH settings or malformed arguments fail with usage', () => {
  const env = { ...process.env };
  delete env.ENSEMBLE_REMOTE_SSH;

  const missingArguments = runScript([], env);
  assert.equal(missingArguments.status, 2);
  assert.match(missingArguments.stderr, /Usage:/);

  const missingSsh = runScript(['/remote/repo', '687'], env);
  assert.equal(missingSsh.status, 2);
  assert.match(missingSsh.stderr, /ENSEMBLE_REMOTE_SSH is required/);
  assert.match(missingSsh.stderr, /Usage:/);

  const misplacedExtraArgument = runScript(
    ['/remote/repo', '687', '--profile', 'team'],
    { ...env, ENSEMBLE_REMOTE_SSH: 'ssh user@remote' },
  );
  assert.equal(misplacedExtraArgument.status, 2);
  assert.match(misplacedExtraArgument.stderr, /additional ensemble arguments must follow --/);
});

async function createFixture({
  startBarrier = 0,
  ensembleExitsImmediately = false,
  paneDead = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-remote-issue-'));
  temporaryRoots.push(root);

  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const remoteHome = join(root, 'remote-home');
  await Promise.all([mkdir(binDir), mkdir(stateDir), mkdir(remoteHome)]);

  const sshPath = join(binDir, 'fake-ssh');
  const tmuxPath = join(binDir, 'tmux');
  const ensemblePath = join(root, 'fake ensemble');
  const sshLog = join(root, 'ssh.jsonl');
  const tmuxLog = join(root, 'tmux.jsonl');
  const ensembleLog = join(root, 'ensemble.jsonl');

  await writeFile(
    sshPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
appendFileSync(process.env.ENSEMBLE_TEST_SSH_LOG, JSON.stringify(args) + '\\n');
const remoteCommand = args.at(-1);
if (!remoteCommand) process.exit(2);

const result = spawnSync('/bin/sh', ['-c', remoteCommand], {
  cwd: process.env.ENSEMBLE_TEST_REMOTE_HOME,
  env: { ...process.env, ENSEMBLE_TEST_CLIENT_ID: String(process.pid) },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`,
    'utf8',
  );
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env node
const { existsSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const logPath = process.env.ENSEMBLE_TEST_TMUX_LOG;
appendFileSync(logPath, JSON.stringify(args) + '\\n');
const stateDir = process.env.ENSEMBLE_TEST_STATE_DIR;
const targetIndex = args.indexOf('-t') + 1;
const sessionIndex = args.indexOf('-s') + 1;
const rawSession = args[args[0] === 'new-session' ? sessionIndex : targetIndex];
const session = rawSession.startsWith('=') ? rawSession.slice(1) : rawSession;
const statePath = join(stateDir, session + '.session');

function readSessionState() {
  if (!existsSync(statePath)) return null;
  const contents = readFileSync(statePath, 'utf8');
  if (!contents || contents === 'starting') return { starting: true };

  let state;
  try {
    state = JSON.parse(contents);
  } catch {
    return { starting: true };
  }
  try {
    process.kill(state.pid, 0);
    return state;
  } catch (error) {
    if (error?.code !== 'ESRCH') return state;
    unlinkSync(statePath);
    return null;
  }
}

if (args[0] === 'has-session') {
  const existedBeforeBarrier = readSessionState() !== null;
  const clientId = process.env.ENSEMBLE_TEST_CLIENT_ID ?? 'unknown';
  const markerPath = join(stateDir, 'initial-' + clientId);
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, '');
    const expected = Number(process.env.ENSEMBLE_TEST_START_BARRIER ?? 0);
    if (expected > 0) {
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 5000;
      while (
        readdirSync(stateDir).filter((name) => name.startsWith('initial-')).length < expected &&
        Date.now() < deadline
      ) {
        Atomics.wait(waitCell, 0, 0, 10);
      }
      if (readdirSync(stateDir).filter((name) => name.startsWith('initial-')).length < expected) {
        process.stderr.write('timed out waiting for concurrent has-session checks\\n');
        process.exit(5);
      }
    }
  }
  process.exit(existedBeforeBarrier ? 0 : 1);
}

if (args[0] === 'list-panes') {
  const state = readSessionState();
  if (!state) process.exit(1);
  process.stdout.write(process.env.ENSEMBLE_TEST_PANE_DEAD === '1' ? '1\\n' : '0\\n');
  process.exit(0);
}

if (args[0] === 'new-session') {
  try {
    const stateFd = openSync(statePath, 'wx');
    closeSync(stateFd);
    writeFileSync(statePath, 'starting');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      process.stderr.write('duplicate session\\n');
      process.exit(1);
    }
    throw error;
  }

  const directory = args[args.indexOf('-c') + 1];
  const commandIndex = args.indexOf('-c') + 2;
  const program = args[commandIndex];
  const child = spawn(program, args.slice(commandIndex + 1), {
    cwd: directory,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', () => {
    unlinkSync(statePath);
    process.exit(0);
  });
  child.once('spawn', () => {
    writeFileSync(statePath, JSON.stringify({ pid: child.pid }));
    child.unref();
    process.exit(0);
  });
}

if (args[0] === 'attach-session') process.exit(0);
if (args[0] !== 'new-session') {
  process.stderr.write('unexpected tmux command: ' + args[0] + '\\n');
  process.exit(2);
}
`,
    'utf8',
  );
  await writeFile(
    ensemblePath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(
  process.env.ENSEMBLE_TEST_ENSEMBLE_LOG,
  JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n',
);
if (process.env.ENSEMBLE_TEST_ENSEMBLE_EXITS_IMMEDIATELY === '1') {
  process.exit(0);
}
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  await Promise.all([sshPath, tmuxPath, ensemblePath].map((path) => chmod(path, 0o755)));

  return {
    root,
    ensembleLog,
    sshLog,
    tmuxLog,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      ENSEMBLE_REMOTE_SSH: `${sshPath} -J bastion user@remote`,
      ENSEMBLE_REMOTE_ENSEMBLE: ensemblePath,
      ENSEMBLE_TEST_ENSEMBLE_LOG: ensembleLog,
      ENSEMBLE_TEST_ENSEMBLE_EXITS_IMMEDIATELY: ensembleExitsImmediately ? '1' : '0',
      ENSEMBLE_TEST_PANE_DEAD: paneDead ? '1' : '0',
      ENSEMBLE_TEST_REMOTE_HOME: remoteHome,
      ENSEMBLE_TEST_SSH_LOG: sshLog,
      ENSEMBLE_TEST_START_BARRIER: String(startBarrier),
      ENSEMBLE_TEST_STATE_DIR: stateDir,
      ENSEMBLE_TEST_TMUX_LOG: tmuxLog,
    },
  };
}

function runScript(args, env) {
  return spawnSync(scriptPath, args, {
    encoding: 'utf8',
    env,
  });
}

function assertNoStartupSuccess(result) {
  assert.doesNotMatch(result.stderr, /tmux session ready:/);
  assert.doesNotMatch(result.stderr, /Reconnect from a TTY/);
}

function runScriptAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args, { env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function readJsonLines(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
