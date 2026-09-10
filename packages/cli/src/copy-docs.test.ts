import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    const destDir = join(root, 'packages', 'cli');

    await mkdir(join(destDir, 'docs', 'stale'), { recursive: true });
    await writeFile(join(destDir, 'README.md'), 'old README\n');
    await writeFile(join(destDir, 'docs', 'stale', 'old.md'), 'stale\n');
    await writeFile(join(destDir, 'config.example.yaml'), 'old: true\n');

    await mkdir(join(docsDir, 'cli'), { recursive: true });
    await writeFile(join(docsDir, 'cli', 'README.md'), 'new README\n');
    await writeFile(join(docsDir, 'settings.md'), 'new settings\n');
    await writeFile(join(docsDir, 'config.md'), 'new config\n');
    await writeFile(configExamplePath, 'new: true\n');

    await copyBundledDocs({ docsDir, configExamplePath, destDir });

    expect(await readFile(join(destDir, 'README.md'), 'utf8')).toBe('new README\n');
    expect(await readFile(join(destDir, 'docs', 'settings.md'), 'utf8')).toBe('new settings\n');
    expect(await readFile(join(destDir, 'docs', 'config.md'), 'utf8')).toBe('new config\n');
    expect(await readFile(join(destDir, 'config.example.yaml'), 'utf8')).toBe('new: true\n');
    expect(existsSync(join(destDir, 'docs', 'stale'))).toBe(false);
  });
});
