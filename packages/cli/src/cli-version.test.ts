import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { readCliPackageVersion } from './cli-version.js';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version: expectedVersion } = require('../package.json') as { version: string };
const cliEntry = join(packageDirectory, '../dist/index.js');

describe('readCliPackageVersion', () => {
  it('returns version from package.json', () => {
    expect(readCliPackageVersion()).toBe(expectedVersion);
  });

  it('feeds commander.version with package.json version', () => {
    const program = new Command();
    program.version(readCliPackageVersion());
    expect(program.version()).toBe(expectedVersion);
  });
});

describe.skipIf(!existsSync(cliEntry))('ensemble --version', () => {
  it('prints package.json version', () => {
    const stdout = execFileSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
    });
    expect(stdout.trim()).toBe(expectedVersion);
  });
});
