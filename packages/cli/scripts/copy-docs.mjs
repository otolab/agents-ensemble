import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledDocs = [
  ['cli/README.md', 'README.md'],
  ['settings.md', 'docs/settings.md'],
  ['config.md', 'docs/config.md'],
  ['pi-conductor-setup.md', 'docs/pi-conductor-setup.md'],
];

/**
 * Copy the user-facing docs into the CLI package, removing stale generated
 * files first so renamed or removed docs do not survive an incremental build.
 */
export async function copyBundledDocs(options) {
  const { docsDir, configExamplePath, piAuthScriptsDir, destDir } = options;
  const generatedPiAuthDir = join(destDir, 'scripts', 'pi');
  await rm(join(destDir, 'README.md'), { force: true });
  await rm(join(destDir, 'docs'), { recursive: true, force: true });
  await rm(join(destDir, 'config.example.yaml'), { force: true });
  await rm(generatedPiAuthDir, { recursive: true, force: true });
  await mkdir(join(destDir, 'docs'), { recursive: true });
  await mkdir(generatedPiAuthDir, { recursive: true });

  for (const [source, destination] of bundledDocs) {
    await cp(join(docsDir, source), join(destDir, destination));
  }
  await cp(configExamplePath, join(destDir, 'config.example.yaml'));
  for (const file of ['cached-auth.mjs', 'cached-auth.sh']) {
    const destination = join(generatedPiAuthDir, file);
    await cp(join(piAuthScriptsDir, file), destination);
    await chmod(destination, 0o755);
  }
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '../..');

await copyBundledDocs({
  docsDir: join(repositoryRoot, 'docs'),
  configExamplePath: join(repositoryRoot, 'config.example.yaml'),
  piAuthScriptsDir: join(repositoryRoot, 'scripts', 'pi'),
  destDir: packageRoot,
});
