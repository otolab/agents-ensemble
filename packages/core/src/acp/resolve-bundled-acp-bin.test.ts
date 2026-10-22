import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ACP_PRESET_OPTIONAL_PACKAGES } from './acp-preset-bins.js';
import * as bundledModule from './resolve-bundled-acp-bin.js';
import { resolveBundledAcpBin } from './resolve-bundled-acp-bin.js';

const { missingClaudeManifestLookups } = vi.hoisted(() => ({
  missingClaudeManifestLookups: [] as string[],
}));

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();

  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url);
      const originalResolve = require.resolve;
      const resolve = ((specifier, options) => {
        if (
          String(url).includes('acp-bundled-bin-absent-') &&
          specifier ===
            `${ACP_PRESET_OPTIONAL_PACKAGES.claude.packageName}/package.json`
        ) {
          missingClaudeManifestLookups.push(String(url));
          const error = new Error(`Cannot find module '${specifier}'`);
          Object.assign(error, { code: 'MODULE_NOT_FOUND' });
          throw error;
        }

        return originalResolve.call(require, specifier, options);
      }) as typeof require.resolve;
      resolve.paths = originalResolve.paths;
      require.resolve = resolve;
      return require;
    },
  };
});

const packageRequire = createRequire(import.meta.url);
const optionalPresets = [
  {
    preset: 'codex',
    packageName: '@agentclientprotocol/codex-acp',
    binName: 'codex-acp',
  },
  {
    preset: 'claude',
    packageName: '@agentclientprotocol/claude-agent-acp',
    binName: 'claude-agent-acp',
  },
  {
    preset: 'pi',
    packageName: 'pi-acp',
    binName: 'pi-acp',
  },
] as const;

function canResolvePackage(packageName: string): boolean {
  try {
    packageRequire.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

async function createCorePackageFixture() {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'acp-bundled-bin-absent-'),
  );
  const callerDirectory = join(fixtureRoot, 'caller');
  const coreDirectory = join(
    fixtureRoot,
    'node_modules',
    '@agents-ensemble',
    'core',
  );
  const callerModulePath = join(callerDirectory, 'entry.mjs');

  await mkdir(callerDirectory, { recursive: true });
  await mkdir(coreDirectory, { recursive: true });
  await writeFile(callerModulePath, '');
  await writeFile(
    join(coreDirectory, 'package.json'),
    JSON.stringify({
      name: '@agents-ensemble/core',
      exports: { '.': { import: './index.js' } },
    }),
  );
  await writeFile(join(coreDirectory, 'index.js'), '');

  return {
    fixtureRoot,
    coreDirectory,
    callerModuleUrl: pathToFileURL(callerModulePath),
  };
}

for (const { preset, packageName, binName } of optionalPresets) {
  describe.skipIf(!canResolvePackage(packageName))(
    `resolveBundledAcpBin(${preset})`,
    () => {
      it(`returns the executable ${binName} path when its package is installed`, () => {
        const bundled = resolveBundledAcpBin(preset);

        expect(bundled).toBeDefined();
        expect(isAbsolute(bundled!)).toBe(true);
        expect(bundled).toContain(binName);
        accessSync(bundled!, constants.X_OK);
      });
    },
  );
}

describe('resolve-bundled-acp-bin when the optional package is absent', () => {
  it('returns undefined when the optional package cannot be resolved', async () => {
    const fixture = await createCorePackageFixture();

    try {
      missingClaudeManifestLookups.length = 0;
      expect(
        resolveBundledAcpBin('claude', fixture.callerModuleUrl),
      ).toBeUndefined();
      expect(missingClaudeManifestLookups).toEqual([
        fixture.callerModuleUrl.href,
      ]);
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('resolve-bundled-acp-bin with an installed package that declares no bin', () => {
  it('returns undefined when the installed optional package declares no bin', async () => {
    const { fixtureRoot, callerModuleUrl } = await createCorePackageFixture();
    const optionalPackage =
      ACP_PRESET_OPTIONAL_PACKAGES.codex.packageName;
    const optionalPackageDirectory = join(
      fixtureRoot,
      'node_modules',
      ...optionalPackage.split('/'),
    );

    try {
      await mkdir(optionalPackageDirectory, { recursive: true });
      await writeFile(
        join(optionalPackageDirectory, 'package.json'),
        JSON.stringify({ name: optionalPackage, bin: {} }),
      );

      expect(
        resolveBundledAcpBin('codex', callerModuleUrl),
      ).toBeUndefined();
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

it('resolves an executable name from PATH to an absolute executable path', () => {
  const fromPath = bundledModule.resolveAcpBinFromPath('node');

  expect(fromPath).toBeDefined();
  expect(isAbsolute(fromPath!)).toBe(true);
  accessSync(fromPath!, constants.X_OK);
});
