import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledDocs = [
  ['cli/README.md', 'README.md'],
  ['settings.md', 'docs/settings.md'],
  ['config.md', 'docs/config.md'],
];

/**
 * Copy the user-facing docs into the CLI package, removing stale generated
 * files first so renamed or removed docs do not survive an incremental build.
 */
export async function copyBundledDocs(options) {
  const { docsDir, configExamplePath, destDir } = options;
  await rm(join(destDir, 'README.md'), { force: true });
  await rm(join(destDir, 'docs'), { recursive: true, force: true });
  await rm(join(destDir, 'config.example.yaml'), { force: true });
  await mkdir(join(destDir, 'docs'), { recursive: true });

  for (const [source, destination] of bundledDocs) {
    await cp(join(docsDir, source), join(destDir, destination));
  }
  await cp(configExamplePath, join(destDir, 'config.example.yaml'));
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '../..');

await copyBundledDocs({
  docsDir: join(repositoryRoot, 'docs'),
  configExamplePath: join(repositoryRoot, 'config.example.yaml'),
  destDir: packageRoot,
});
