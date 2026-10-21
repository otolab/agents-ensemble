import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

export function classifyReleasePush({
  hasChangesets,
  skipMarker,
  created,
  appliedPackages,
}) {
  if (!hasChangesets && !created && appliedPackages.length > 0) {
    return 'already_versioned';
  }
  if (skipMarker) {
    return created ? 'skip_initial' : 'skip';
  }
  if (hasChangesets) {
    return 'apply';
  }
  return 'missing';
}

export function findAppliedPackages(previousPackages, currentPackages, changedFiles) {
  const previousByName = new Map(previousPackages.map((pkg) => [pkg.name, pkg]));
  const bumpedPackages = currentPackages.filter((pkg) => {
    const previous = previousByName.get(pkg.name);
    return (
      !pkg.private &&
      previous &&
      semver.valid(previous.version) &&
      semver.valid(pkg.version) &&
      semver.gt(pkg.version, previous.version)
    );
  });

  if (bumpedPackages.length === 0) {
    return [];
  }

  const changedFileSet = new Set(changedFiles);
  const hasAllChangelogs = bumpedPackages.every((pkg) => {
    const changelog = path.posix.join(pkg.directory, 'CHANGELOG.md');
    return changedFileSet.has(changelog);
  });

  return hasAllChangelogs ? bumpedPackages.map((pkg) => pkg.name) : [];
}

function packageStatesAt(ref) {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = path.posix.join('packages', entry.name);
      try {
        const contents = execFileSync('git', ['show', `${ref}:${directory}/package.json`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const pkg = JSON.parse(contents);
        return [{
          name: pkg.name,
          version: pkg.version,
          private: pkg.private === true,
          directory,
        }];
      } catch {
        return [];
      }
    });
}

function changedFilesBetween(before, head) {
  return execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', before, head, '--', 'packages'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

function main() {
  const [before, head, hasChangesetsArg, skipMarkerArg, createdArg] = process.argv.slice(2);
  if (!before || !head || !hasChangesetsArg || !skipMarkerArg || !createdArg) {
    throw new Error('Expected before, head, hasChangesets, skipMarker, and created arguments');
  }

  const hasChangesets = hasChangesetsArg === 'true';
  const skipMarker = skipMarkerArg === 'true';
  const created = createdArg === 'true';
  let appliedPackages = [];

  if (!hasChangesets && !created && !/^0+$/.test(before)) {
    appliedPackages = findAppliedPackages(
      packageStatesAt(before),
      packageStatesAt(head),
      changedFilesBetween(before, head),
    );
  }

  const mode = classifyReleasePush({
    hasChangesets,
    skipMarker,
    created,
    appliedPackages,
  });

  if (mode === 'already_versioned') {
    console.error(`Changesets already applied to: ${appliedPackages.join(', ')}`);
  }
  console.log(mode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
