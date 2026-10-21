import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
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

export function releaseStepOutputs(mode) {
  const outputFlags = {
    apply: {
      has_changesets: true,
      skip_changeset: false,
      already_versioned: false,
      skip_initial: false,
      apply_version_updates: true,
      update_root_version: false,
      create_release_pr: true,
      missing_changesets: false,
    },
    skip: {
      has_changesets: false,
      skip_changeset: true,
      already_versioned: false,
      skip_initial: false,
      apply_version_updates: false,
      update_root_version: false,
      create_release_pr: true,
      missing_changesets: false,
    },
    skip_initial: {
      has_changesets: false,
      skip_changeset: true,
      already_versioned: false,
      skip_initial: true,
      apply_version_updates: false,
      update_root_version: true,
      create_release_pr: true,
      missing_changesets: false,
    },
    already_versioned: {
      has_changesets: false,
      skip_changeset: false,
      already_versioned: true,
      skip_initial: false,
      apply_version_updates: false,
      update_root_version: false,
      create_release_pr: true,
      missing_changesets: false,
    },
    missing: {
      has_changesets: false,
      skip_changeset: false,
      already_versioned: false,
      skip_initial: false,
      apply_version_updates: false,
      update_root_version: false,
      create_release_pr: false,
      missing_changesets: true,
    },
  };

  const flags = outputFlags[mode];
  if (!flags) {
    throw new Error(`Unknown release push mode: ${mode}`);
  }

  return { release_mode: mode, ...flags };
}

function packageStatesAt(ref) {
  let complete = true;
  const packageStates = readdirSync('packages', { withFileTypes: true })
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
        complete = false;
        return [];
      }
    });

  return complete ? packageStates : null;
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

function hasChangesetFiles() {
  try {
    return readdirSync('.changeset', { withFileTypes: true }).some(
      (entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md',
    );
  } catch {
    return false;
  }
}

function main() {
  const [before, head, createdArg] = process.argv.slice(2);
  if (!before || !head || !createdArg) {
    throw new Error('Expected before, head, and created arguments');
  }

  const hasChangesets = hasChangesetFiles();
  const lastCommitMessage = execFileSync('git', ['log', '-1', '--pretty=%B', head], {
    encoding: 'utf8',
  });
  const skipMarker = /\[skip-changeset\]/.test(lastCommitMessage);
  const created = createdArg === 'true';
  let appliedPackages = [];

  if (!hasChangesets && !created && !/^0+$/.test(before)) {
    const previousPackages = packageStatesAt(before);
    const currentPackages = packageStatesAt(head);
    if (previousPackages && currentPackages) {
      appliedPackages = findAppliedPackages(
        previousPackages,
        currentPackages,
        changedFilesBetween(before, head),
      );
    } else {
      console.error('Package manifests could not be read at both refs; refusing already-versioned classification');
    }
  }

  const mode = classifyReleasePush({
    hasChangesets,
    skipMarker,
    created,
    appliedPackages,
  });

  const outputs = releaseStepOutputs(mode);
  const outputLines = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputLines}\n`);
  } else {
    console.log(outputLines);
  }

  if (mode === 'already_versioned') {
    console.error(`Changesets already applied to: ${appliedPackages.join(', ')}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
