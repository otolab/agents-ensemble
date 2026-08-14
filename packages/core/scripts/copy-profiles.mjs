import { cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copy bundled profiles into dist, removing any previous copy first.
 * Stale directories (e.g. after renames) must not survive incremental builds.
 */
export async function copyBundledProfiles(options) {
  const { sourceDir, destDir } = options;
  await rm(destDir, { recursive: true, force: true });
  await cp(sourceDir, destDir, { recursive: true });
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

await copyBundledProfiles({
  sourceDir: join(packageRoot, '../../profiles'),
  destDir: join(packageRoot, 'dist/profiles'),
});
