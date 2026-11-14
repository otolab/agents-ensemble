import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import {
  assertBuiltinPiNodeVersionSupported,
  configurePiWorkerRuntime,
  isBuiltinPiNodeVersionSupported,
  resolveBuiltinPiAcpEntrypointPath,
  resolveBuiltinPiAcpWrapperPath,
  resolveBuiltinPiCliEnvWrapperPath,
  resolveBundledPiCliPath,
} from './pi-runtime.js';
import type { ResolvedAcpSpawn } from './resolve-acp-spawn.js';

describe('builtin Pi runtime helpers', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it.each([
    ['22.18.9', false],
    ['22.19.0-rc.1', false],
    ['22.19.0', true],
    ['22.20.0', true],
    ['23.0.0', true],
  ])('checks the Pi CLI Node.js engine range for %s', (version, supported) => {
    expect(isBuiltinPiNodeVersionSupported(version)).toBe(supported);
    if (supported) {
      expect(() => assertBuiltinPiNodeVersionSupported(version)).not.toThrow();
    } else {
      expect(() => assertBuiltinPiNodeVersionSupported(version)).toThrow(
        /requires Node\.js 22\.19\.0 or later/,
      );
    }
  });

  it('resolves the pi bin declared by the bundled Pi package', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-cli-'));
    const packageRoot = join(
      tempRoot,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    );
    const callerPath = join(tempRoot, 'app', 'entry.mjs');
    const cliPath = join(packageRoot, 'dist', 'bundle', 'cli.js');
    await Promise.all([
      mkdir(join(packageRoot, 'dist', 'bundle'), { recursive: true }),
      mkdir(join(tempRoot, 'app'), { recursive: true }),
    ]);
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        main: 'dist/index.js',
        bin: { pi: 'dist/bundle/cli.js' },
      }),
    );
    await writeFile(join(packageRoot, 'dist', 'index.js'), '');
    await writeFile(cliPath, '');
    await writeFile(callerPath, '');

    expect(resolveBundledPiCliPath(pathToFileURL(callerPath))).toBe(cliPath);
  });

  it('resolves the builtin-only alias to the pinned upstream adapter bin', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-acp-'));
    const packageRoot = join(tempRoot, 'node_modules', 'pi-acp-builtin');
    const callerPath = join(tempRoot, 'app', 'entry.mjs');
    const entrypoint = join(packageRoot, 'dist', 'index.js');
    await Promise.all([
      mkdir(dirname(entrypoint), { recursive: true }),
      mkdir(join(tempRoot, 'app'), { recursive: true }),
    ]);
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'pi-acp',
        version: '0.0.34',
        bin: { 'pi-acp': 'dist/index.js' },
      }),
    );
    await writeFile(entrypoint, '');
    await writeFile(callerPath, '');

    expect(
      resolveBuiltinPiAcpEntrypointPath(pathToFileURL(callerPath)),
    ).toBe(realpathSync(entrypoint));
  });

  it('resolves the installed builtin adapter alias to upstream pi-acp@0.0.34', () => {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve('pi-acp-builtin/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      version: string;
    };

    expect(manifest).toMatchObject({ name: 'pi-acp', version: '0.0.34' });
    expect(resolveBuiltinPiAcpEntrypointPath()).toBe(
      realpathSync(join(dirname(manifestPath), 'dist', 'index.js')),
    );
  });

  it('resolves core wrappers from the published dist layout', async () => {
    const packageDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
    );
    expect(resolveBuiltinPiAcpWrapperPath()).toBe(
      join(packageDirectory, 'dist', 'acp', 'pi-acp-wrapper.js'),
    );

    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-wrapper-'));
    const publishedPackage = join(tempRoot, 'package');
    const runtimePath = join(
      publishedPackage,
      'dist',
      'acp',
      'pi-runtime.js',
    );
    const wrapperName =
      process.platform === 'win32'
        ? 'pi-cli-env-wrapper.cmd'
        : 'pi-cli-env-wrapper.sh';
    const wrapperPath = join(publishedPackage, 'assets', 'pi', wrapperName);
    await mkdir(dirname(runtimePath), { recursive: true });
    await mkdir(dirname(wrapperPath), { recursive: true });
    await writeFile(runtimePath, '');
    await writeFile(wrapperPath, '');

    expect(resolveBuiltinPiCliEnvWrapperPath(pathToFileURL(runtimePath))).toBe(
      wrapperPath,
    );
  });
});

describe('configurePiWorkerRuntime', () => {
  let tempRoot = '';

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  async function setupHome() {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-pi-runtime-'));
    const hostHome = join(tempRoot, 'operator-home');
    const userRoot = join(tempRoot, 'ensemble-user');
    const repoRoot = join(tempRoot, 'repo');
    const hostUserProfile = join(tempRoot, 'operator-profile');
    vi.stubEnv('HOME', hostHome);
    vi.stubEnv('USERPROFILE', hostUserProfile);
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    return { hostHome, hostUserProfile, repoRoot };
  }

  const builtinSpawn = (): ResolvedAcpSpawn => ({
    preset: 'pi',
    command: 'pi-acp',
    args: [],
    piRuntime: 'builtin',
  });

  it('keeps adapter map storage isolated and gives Pi the operator home', async () => {
    const { hostHome, hostUserProfile, repoRoot } = await setupHome();
    const configured = configurePiWorkerRuntime(builtinSpawn(), {
      repoRoot,
      issueNumber: 1,
      workerName: 'implementer',
    });
    const workerHome = resolveEnsemblePaths({ repoRoot }).piWorkerDir(
      'implementer',
      1,
    );

    expect(configured.env).toMatchObject({
      HOME: workerHome,
      USERPROFILE: workerHome,
      ENSEMBLE_PI_LEGACY_WORKER_HOME:
        resolveEnsemblePaths({ repoRoot }).legacyPiWorkerDir('implementer'),
      ENSEMBLE_PI_CLI_HOME: hostHome,
      ENSEMBLE_PI_CLI_USERPROFILE: hostUserProfile,
      ENSEMBLE_PI_CLI_NODE: process.execPath,
      PI_CODING_AGENT_SESSION_DIR:
        resolveEnsemblePaths({ repoRoot }).piWorkerSessionsDir(
          'implementer',
          1,
        ),
    });
    expect(configured.env?.PI_ACP_PI_COMMAND).toBe(
      resolveBuiltinPiCliEnvWrapperPath(),
    );
    expect(configured.env?.PI_ACP_PI_COMMAND).not.toBe(
      configured.env?.ENSEMBLE_PI_CLI_EXECUTABLE,
    );
  });

  it('uses explicit acp.env home values for the Pi CLI process only', async () => {
    const { repoRoot } = await setupHome();
    const configured = configurePiWorkerRuntime(
      {
        ...builtinSpawn(),
        env: { HOME: join(tempRoot, 'acp-home') },
      },
      {
        repoRoot,
        issueNumber: 1,
        workerName: 'implementer',
      },
    );
    const workerHome = resolveEnsemblePaths({ repoRoot }).piWorkerDir(
      'implementer',
      1,
    );

    expect(configured.env?.HOME).toBe(workerHome);
    expect(configured.env?.USERPROFILE).toBe(workerHome);
    expect(configured.env?.ENSEMBLE_PI_CLI_HOME).toBe(
      join(tempRoot, 'acp-home'),
    );
    expect(configured.env?.ENSEMBLE_PI_CLI_USERPROFILE).toBe(
      join(tempRoot, 'acp-home'),
    );
  });

  it('uses explicit acp.env.USERPROFILE for the Pi CLI process', async () => {
    const { repoRoot } = await setupHome();
    const configured = configurePiWorkerRuntime(
      {
        ...builtinSpawn(),
        env: { USERPROFILE: join(tempRoot, 'acp-profile') },
      },
      {
        repoRoot,
        issueNumber: 1,
        workerName: 'implementer',
      },
    );

    expect(configured.env?.HOME).toBe(
      resolveEnsemblePaths({ repoRoot }).piWorkerDir('implementer', 1),
    );
    expect(configured.env?.USERPROFILE).toBe(
      resolveEnsemblePaths({ repoRoot }).piWorkerDir('implementer', 1),
    );
    expect(configured.env?.ENSEMBLE_PI_CLI_HOME).toBe(
      join(tempRoot, 'acp-profile'),
    );
    expect(configured.env?.ENSEMBLE_PI_CLI_USERPROFILE).toBe(
      join(tempRoot, 'acp-profile'),
    );
  });

  it('leaves BYO Pi spawn settings unchanged', async () => {
    const { repoRoot } = await setupHome();
    const byoSpawn: ResolvedAcpSpawn = {
      preset: 'pi',
      command: 'pi-acp',
      args: [],
      env: { HOME: join(tempRoot, 'byo-home') },
    };

    expect(
      configurePiWorkerRuntime(byoSpawn, {
        repoRoot,
        issueNumber: 1,
        workerName: 'implementer',
      }),
    ).toBe(byoSpawn);
  });
});
