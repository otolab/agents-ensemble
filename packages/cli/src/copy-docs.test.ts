import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyBundledDocs } from '../scripts/copy-docs.mjs';

describe('copyBundledDocs', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ensemble-copy-docs-'));
  });

  afterEach(() => {
    root = '';
  });

  it('removes stale generated files before copying the canonical docs', async () => {
    const docsDir = join(root, 'docs');
    const configExamplePath = join(root, 'config.example.yaml');
    const piAuthScriptsDir = join(root, 'scripts', 'pi');
    const destDir = join(root, 'packages', 'cli');

    await mkdir(join(destDir, 'docs', 'stale'), { recursive: true });
    await writeFile(join(destDir, 'README.md'), 'old README\n');
    await writeFile(join(destDir, 'docs', 'stale', 'old.md'), 'stale\n');
    await writeFile(join(destDir, 'config.example.yaml'), 'old: true\n');

    await mkdir(join(docsDir, 'cli'), { recursive: true });
    await mkdir(piAuthScriptsDir, { recursive: true });
    await writeFile(join(docsDir, 'cli', 'README.md'), 'new README\n');
    await writeFile(join(docsDir, 'settings.md'), 'new settings\n');
    await writeFile(join(docsDir, 'config.md'), 'new config\n');
    await writeFile(join(docsDir, 'pi-conductor-setup.md'), 'new Pi setup\n');
    await writeFile(join(piAuthScriptsDir, 'cached-auth.mjs'), '#!/usr/bin/env node\n');
    await writeFile(join(piAuthScriptsDir, 'cached-auth.sh'), '#!/usr/bin/env bash\n');
    await writeFile(configExamplePath, 'new: true\n');

    await copyBundledDocs({ docsDir, configExamplePath, piAuthScriptsDir, destDir });

    expect(await readFile(join(destDir, 'README.md'), 'utf8')).toBe('new README\n');
    expect(await readFile(join(destDir, 'docs', 'settings.md'), 'utf8')).toBe('new settings\n');
    expect(await readFile(join(destDir, 'docs', 'config.md'), 'utf8')).toBe('new config\n');
    expect(await readFile(join(destDir, 'docs', 'pi-conductor-setup.md'), 'utf8')).toBe(
      'new Pi setup\n',
    );
    expect(await readFile(join(destDir, 'config.example.yaml'), 'utf8')).toBe('new: true\n');
    expect(await readFile(join(destDir, 'scripts', 'pi', 'cached-auth.mjs'), 'utf8')).toBe(
      '#!/usr/bin/env node\n',
    );
    expect(await readFile(join(destDir, 'scripts', 'pi', 'cached-auth.sh'), 'utf8')).toBe(
      '#!/usr/bin/env bash\n',
    );
    expect(
      (await stat(join(destDir, 'scripts', 'pi', 'cached-auth.mjs'))).mode & 0o111,
    ).toBe(0o111);
    expect(existsSync(join(destDir, 'docs', 'stale'))).toBe(false);
  });
});
