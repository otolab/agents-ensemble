import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACP_PRESET_OPTIONAL_PACKAGES } from './acp-preset-bins.js';
import * as bundledModule from './resolve-bundled-acp-bin.js';
import { resolveBundledAcpBin } from './resolve-bundled-acp-bin.js';

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

describe('resolve-bundled-acp-bin without optional packages', () => {
  it('returns undefined when the installed optional package declares no bin', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'acp-bundled-bin-'));
    const callerDirectory = join(fixtureRoot, 'caller');
    const coreDirectory = join(
      fixtureRoot,
      'node_modules',
      '@agents-ensemble',
      'core',
    );
    const optionalPackage =
      ACP_PRESET_OPTIONAL_PACKAGES.codex.packageName;
    const optionalPackageDirectory = join(
      fixtureRoot,
      'node_modules',
      ...optionalPackage.split('/'),
    );
    const callerModulePath = join(callerDirectory, 'entry.mjs');

    try {
      await mkdir(callerDirectory, { recursive: true });
      await mkdir(coreDirectory, { recursive: true });
      await mkdir(optionalPackageDirectory, { recursive: true });
      await writeFile(callerModulePath, '');
      await writeFile(
        join(coreDirectory, 'package.json'),
        JSON.stringify({ name: '@agents-ensemble/core', main: 'index.js' }),
      );
      await writeFile(join(coreDirectory, 'index.js'), '');
      await writeFile(
        join(optionalPackageDirectory, 'package.json'),
        JSON.stringify({ name: optionalPackage, bin: {} }),
      );

      expect(
        resolveBundledAcpBin('codex', pathToFileURL(callerModulePath)),
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
