import { spawn } from 'node:child_process';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { loginPiConductor } from './conductor-pi-auth.js';

const workerRole = process.env.PI_AUTH_PROCESS_TEST_ROLE;

if (workerRole === 'first' || workerRole === 'second' || workerRole === 'third') {
  it(
    'runs a production OpenAI login in a separate process',
    async () => {
      const cwd = process.env.PI_AUTH_PROCESS_TEST_CWD!;
      const agentDir = process.env.PI_AUTH_PROCESS_TEST_AGENT_DIR!;
      const projectDir = process.env.PI_AUTH_PROCESS_TEST_PROJECT_DIR!;
      const readyPath = process.env.PI_AUTH_PROCESS_TEST_READY_PATH!;
      const runtimeIdPath = process.env.PI_AUTH_PROCESS_TEST_RUNTIME_ID_PATH!;
      const gatePath = process.env.PI_AUTH_PROCESS_TEST_GATE_PATH!;

      await writeFile(readyPath, 'ready');
      if (workerRole !== 'third') await waitForFile(gatePath);

      const runtimeLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
          const deviceId = loginOptions?.getDeviceId?.();
          if (!deviceId) throw new Error('Production OAuth login received no device ID');
          await writeFile(runtimeIdPath, deviceId);
          return mockOAuthCredential();
        });

      await loginPiConductor({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: {
          onAuth: async () => undefined,
          onDeviceCode: async () => undefined,
          onPrompt: async () => 'answer',
          onSelect: async () => 'option',
        },
      });

      expect(runtimeLogin).toHaveBeenCalledOnce();
      expect(await readFile(runtimeIdPath, 'utf8')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    },
    20_000,
  );
}

describe('Pi user-root lock through production OAuth login', () => {
  it(
    'keeps the runtime and persisted device ID stable across concurrent processes and a later login',
    async () => {
      const fixture = await createAuthFixture();
      const originalProjectSettings =
        '{"defaultProvider":"openai","defaultModel":"gpt-6.1-sol","projectMarker":"owned"}\n';
      const projectSettingsPath = join(fixture.projectDir, 'settings.json');
      const userSettingsPath = join(fixture.agentDir, 'settings.json');
      await writeFile(projectSettingsPath, originalProjectSettings);
      await link(projectSettingsPath, userSettingsPath);

      const gatePath = join(fixture.baseDir, 'release-logins');
      const first = spawnLoginWorker('first', fixture, gatePath);
      const second = spawnLoginWorker('second', fixture, gatePath);
      let third: ReturnType<typeof spawnLoginWorker> | undefined;

      try {
        await Promise.all([
          waitForFile(first.readyPath),
          waitForFile(second.readyPath),
        ]);
        await writeFile(gatePath, 'go');

        const [firstExit, secondExit] = await Promise.all([
          first.exit,
          second.exit,
        ]);
        expect(
          firstExit.code,
          `first production login failed:\n${firstExit.stdout}\n${firstExit.stderr}`,
        ).toBe(0);
        expect(
          secondExit.code,
          `second production login failed:\n${secondExit.stdout}\n${secondExit.stderr}`,
        ).toBe(0);

        const [firstRuntimeId, secondRuntimeId] = await Promise.all([
          readFile(first.runtimeIdPath, 'utf8'),
          readFile(second.runtimeIdPath, 'utf8'),
        ]);
        expect(secondRuntimeId).toBe(firstRuntimeId);

        const [userSettings, projectSettings] = await Promise.all([
          stat(userSettingsPath),
          stat(projectSettingsPath),
        ]);
        expect(userSettings.nlink).toBe(1);
        expect(projectSettings.nlink).toBe(1);
        if (userSettings.ino !== 0 && projectSettings.ino !== 0) {
          expect(userSettings.ino).not.toBe(projectSettings.ino);
        }
        expect(await readFile(projectSettingsPath, 'utf8')).toBe(
          originalProjectSettings,
        );
        expect(JSON.parse(await readFile(userSettingsPath, 'utf8'))).toMatchObject({
          deviceId: firstRuntimeId,
          projectMarker: 'owned',
        });

        third = spawnLoginWorker('third', fixture, gatePath);
        await waitForFile(third.readyPath);
        const thirdExit = await third.exit;
        expect(
          thirdExit.code,
          `later production login failed:\n${thirdExit.stdout}\n${thirdExit.stderr}`,
        ).toBe(0);
        await expect(readFile(third.runtimeIdPath, 'utf8')).resolves.toBe(
          firstRuntimeId,
        );
        expect(JSON.parse(await readFile(userSettingsPath, 'utf8')).deviceId).toBe(
          firstRuntimeId,
        );
      } finally {
        await writeFile(gatePath, 'go').catch(() => undefined);
        const exits = [first.exit, second.exit];
        if (third) exits.push(third.exit);
        await Promise.all(exits);
        await rm(fixture.baseDir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it.each([
    'project file symlink to the lock sidecar',
    'lock sidecar file symlink to a project file',
    'lock sidecar directory symlink to a project directory',
  ])('rejects a project-owned lock sidecar alias: %s', async (aliasKind) => {
    const fixture = await createAuthFixture();
    const lockPath = `${await realpath(fixture.agentDir)}.lock`;
    const ensembleDir = dirname(fixture.projectDir);
    const runtimeLogin = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockResolvedValue(mockOAuthCredential());

    try {
      if (aliasKind === 'project file symlink to the lock sidecar') {
        await symlink(lockPath, join(ensembleDir, 'lock-sidecar-alias'), 'dir');
      } else if (aliasKind === 'lock sidecar file symlink to a project file') {
        const projectFile = join(ensembleDir, 'owned-file');
        await writeFile(projectFile, 'project-owned');
        await symlink(projectFile, lockPath, 'file');
      } else {
        await symlink(fixture.projectDir, lockPath, 'dir');
      }

      await expect(
        loginPiConductor({
          cwd: fixture.cwd,
          pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
          provider: 'openai',
          modelId: 'gpt-6.1-sol',
          oauthCallbacks: createOAuthCallbacks(),
        }),
      ).rejects.toThrow(/Refusing to create Pi user-root lock/);

      expect(runtimeLogin).not.toHaveBeenCalled();
      if (aliasKind !== 'project file symlink to the lock sidecar') {
        expect((await stat(fixture.projectDir)).isDirectory()).toBe(true);
        expect(await readlink(lockPath)).toBe(
          aliasKind === 'lock sidecar file symlink to a project file'
            ? join(ensembleDir, 'owned-file')
            : fixture.projectDir,
        );
      }
    } finally {
      await rm(fixture.baseDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it('detects a case-only project alias of the lock path on case-insensitive volumes', async () => {
    const fixture = await createAuthFixture();
    const lockPath = `${await realpath(fixture.agentDir)}.lock`;
    const alternateCaseLockPath = alternateCase(lockPath);
    const projectAlias = join(dirname(fixture.projectDir), 'case-lock-alias');
    const caseInsensitive = await hasCaseInsensitiveDirectoryNames(fixture.baseDir);
    const runtimeLogin = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockResolvedValue(mockOAuthCredential());

    try {
      await symlink(alternateCaseLockPath, projectAlias, 'dir');
      const login = loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      });

      if (caseInsensitive) {
        await expect(login).rejects.toThrow(/Refusing to create Pi user-root lock/);
        expect(runtimeLogin).not.toHaveBeenCalled();
      } else {
        await expect(login).resolves.toMatchObject({ method: 'oauth' });
        expect(runtimeLogin).toHaveBeenCalledOnce();
      }
    } finally {
      await rm(fixture.baseDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

interface AuthFixture {
  baseDir: string;
  cwd: string;
  agentDir: string;
  projectDir: string;
}

function createOAuthCallbacks() {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn().mockResolvedValue('answer'),
    onSelect: vi.fn().mockResolvedValue('option'),
  };
}

function mockOAuthCredential() {
  return {
    type: 'oauth' as const,
    refresh: 'mock-refresh',
    access: 'mock-access',
    expires: Date.now() + 60_000,
  };
}

async function createAuthFixture(): Promise<AuthFixture> {
  const baseDir = await mkdtemp(join(tmpdir(), 'pi-auth-root-lock-'));
  const cwd = join(baseDir, 'project');
  const agentDir = join(baseDir, 'user-pi');
  const projectDir = join(cwd, '.ensemble', 'pi');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
  ]);
  return { baseDir, cwd, agentDir, projectDir };
}

function spawnLoginWorker(
  role: 'first' | 'second' | 'third',
  fixture: AuthFixture,
  gatePath: string,
) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const readyPath = join(fixture.baseDir, `${role}-ready`);
  const runtimeIdPath = join(fixture.baseDir, `${role}-runtime-id`);
  const child = spawn(
    process.execPath,
    [
      join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'src/conductor/pi-user-root-lock.test.ts',
      '-t',
      'runs a production OpenAI login in a separate process',
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PI_AUTH_PROCESS_TEST_ROLE: role,
        PI_AUTH_PROCESS_TEST_CWD: fixture.cwd,
        PI_AUTH_PROCESS_TEST_AGENT_DIR: fixture.agentDir,
        PI_AUTH_PROCESS_TEST_PROJECT_DIR: fixture.projectDir,
        PI_AUTH_PROCESS_TEST_READY_PATH: readyPath,
        PI_AUTH_PROCESS_TEST_RUNTIME_ID_PATH: runtimeIdPath,
        PI_AUTH_PROCESS_TEST_GATE_PATH: gatePath,
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
  return { exit, readyPath, runtimeIdPath };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
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

async function hasCaseInsensitiveDirectoryNames(directory: string): Promise<boolean> {
  const probe = join(directory, 'caseProbe');
  await mkdir(probe);
  try {
    const [original, alternate] = await Promise.all([
      stat(probe),
      stat(join(directory, 'CASEPROBE')),
    ]);
    return original.dev === alternate.dev && original.ino === alternate.ino;
  } catch {
    return false;
  }
}

function alternateCase(path: string): string {
  return path.replace(/[a-z]/, (letter) => letter.toUpperCase());
}
