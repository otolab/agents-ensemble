import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyBundledProfiles } from '../../scripts/copy-profiles.mjs';

describe('copyBundledProfiles', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ensemble-copy-profiles-'));
  });

  afterEach(() => {
    root = '';
  });

  it('removes stale profile directories before copying', async () => {
    const sourceDir = join(root, 'profiles');
    const destDir = join(root, 'dist', 'profiles');

    await mkdir(join(destDir, 'default'), { recursive: true });
    await writeFile(join(destDir, 'default', 'profile.yaml'), 'workers: []\n');

    await mkdir(join(sourceDir, 'implementer-and-reviewer'), { recursive: true });
    await writeFile(
      join(sourceDir, 'implementer-and-reviewer', 'profile.yaml'),
      'workers: []\n',
    );

    await copyBundledProfiles({ sourceDir, destDir });

    expect(existsSync(join(destDir, 'default'))).toBe(false);
    expect(existsSync(join(destDir, 'implementer-and-reviewer', 'profile.yaml'))).toBe(true);
  });
});
