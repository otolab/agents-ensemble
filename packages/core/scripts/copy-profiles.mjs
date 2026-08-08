import { cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoProfiles = join(packageRoot, '../../profiles');

await cp(repoProfiles, join(packageRoot, 'dist/profiles'), {
  recursive: true,
});
