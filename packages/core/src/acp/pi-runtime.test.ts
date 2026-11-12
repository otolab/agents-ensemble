import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBuiltinPiNodeVersionSupported,
  isBuiltinPiNodeVersionSupported,
  resolveBuiltinPiAcpWrapperPath,
  resolveBundledPiCliPath,
} from './pi-runtime.js';

describe('builtin Pi runtime', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
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

  it('resolves the core wrapper from the published dist layout', () => {
    const packageDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
    );

    expect(resolveBuiltinPiAcpWrapperPath()).toBe(
      join(packageDirectory, 'dist', 'acp', 'pi-acp-wrapper.js'),
    );
  });
});
