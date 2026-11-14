import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { withPiUserRootLock } from './pi-user-root-lock.js';

const workerRole = process.env.PI_USER_ROOT_LOCK_TEST_ROLE;

if (workerRole === 'first' || workerRole === 'second') {
  it(
    'runs a device ID transaction under the user-root lock',
    async () => {
      const agentDir = process.env.PI_USER_ROOT_LOCK_AGENT_DIR!;
      const cwd = process.env.PI_USER_ROOT_LOCK_CWD!;
      const attemptPath = process.env.PI_USER_ROOT_LOCK_ATTEMPT_PATH!;
      const enteredPath = process.env.PI_USER_ROOT_LOCK_ENTERED_PATH!;
      const resultPath = process.env.PI_USER_ROOT_LOCK_RESULT_PATH!;
      const releasePath = process.env.PI_USER_ROOT_LOCK_RELEASE_PATH!;
      await writeFile(attemptPath, 'attempting');

      await withPiUserRootLock(agentDir, async () => {
        const manager = SettingsManager.create(cwd, agentDir);
        const deviceId = manager.getOrCreateDeviceId();
        await writeFile(enteredPath, deviceId);
        if (workerRole === 'first') await waitForFile(releasePath);
        await manager.flush();
        const errors = manager
          .drainErrors()
          .filter(({ scope }) => scope === 'global');
        if (errors.length > 0) throw errors[0]!.error;
        await writeFile(resultPath, deviceId);
      });
    },
    15_000,
  );
}

describe('Pi user-root lock', () => {
  it(
    'serializes concurrent device ID creation across processes',
    async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'pi-user-root-lock-'));
      const agentDir = join(baseDir, 'user-pi');
      const cwd = join(baseDir, 'project');
      await Promise.all([
        mkdir(agentDir, { recursive: true }),
        mkdir(cwd, { recursive: true }),
      ]);

      const releasePath = join(baseDir, 'release-first');
      const paths = {
        firstAttempt: join(baseDir, 'first-attempt'),
        firstEntered: join(baseDir, 'first-entered'),
        firstResult: join(baseDir, 'first-result'),
        secondAttempt: join(baseDir, 'second-attempt'),
        secondEntered: join(baseDir, 'second-entered'),
        secondResult: join(baseDir, 'second-result'),
      };
      let first: ReturnType<typeof spawnLockWorker> | undefined;
      let second: ReturnType<typeof spawnLockWorker> | undefined;

      try {
        first = spawnLockWorker('first', {
          agentDir,
          cwd,
          attemptPath: paths.firstAttempt,
          enteredPath: paths.firstEntered,
          resultPath: paths.firstResult,
          releasePath,
        });
        await waitForFile(paths.firstEntered);

        second = spawnLockWorker('second', {
          agentDir,
          cwd,
          attemptPath: paths.secondAttempt,
          enteredPath: paths.secondEntered,
          resultPath: paths.secondResult,
          releasePath,
        });
        await waitForFile(paths.secondAttempt);
        await delay(200);
        await expect(readFile(paths.secondEntered, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });

        await writeFile(releasePath, 'continue');
        const [firstExit, secondExit] = await Promise.all([
          first.exit,
          second.exit,
        ]);
        expect(
          firstExit.code,
          `first worker failed:\n${firstExit.stdout}\n${firstExit.stderr}`,
        ).toBe(0);
        expect(
          secondExit.code,
          `second worker failed:\n${secondExit.stdout}\n${secondExit.stderr}`,
        ).toBe(0);

        const [firstId, secondId] = await Promise.all([
          readFile(paths.firstResult, 'utf8'),
          readFile(paths.secondResult, 'utf8'),
        ]);
        const settings = JSON.parse(
          await readFile(join(agentDir, 'settings.json'), 'utf8'),
        ) as { deviceId?: string };
        expect(firstId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(secondId).toBe(firstId);
        expect(settings.deviceId).toBe(firstId);
      } finally {
        await writeFile(releasePath, 'continue').catch(() => undefined);
        await Promise.all(
          [first?.exit, second?.exit].filter(
            (result): result is NonNullable<typeof result> => result !== undefined,
          ),
        );
        await rm(baseDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

function spawnLockWorker(
  role: 'first' | 'second',
  paths: {
    agentDir: string;
    cwd: string;
    attemptPath: string;
    enteredPath: string;
    resultPath: string;
    releasePath: string;
  },
) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const child = spawn(
    process.execPath,
    [
      join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'src/conductor/pi-user-root-lock.test.ts',
      '-t',
      'runs a device ID transaction under the user-root lock',
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PI_USER_ROOT_LOCK_TEST_ROLE: role,
        PI_USER_ROOT_LOCK_AGENT_DIR: paths.agentDir,
        PI_USER_ROOT_LOCK_CWD: paths.cwd,
        PI_USER_ROOT_LOCK_ATTEMPT_PATH: paths.attemptPath,
        PI_USER_ROOT_LOCK_ENTERED_PATH: paths.enteredPath,
        PI_USER_ROOT_LOCK_RESULT_PATH: paths.resultPath,
        PI_USER_ROOT_LOCK_RELEASE_PATH: paths.releasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExit({ code, stdout, stderr }));
  });
  return { exit };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
