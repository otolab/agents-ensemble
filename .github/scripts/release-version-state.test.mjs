import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyReleasePush,
  findAppliedPackages,
} from './release-version-state.mjs';

const previousPackages = [
  { name: '@agents-ensemble/core', version: '0.14.1', directory: 'packages/core' },
  { name: '@agents-ensemble/cli', version: '0.14.1', directory: 'packages/cli' },
  { name: '@agents-ensemble/operator-agent', version: '0.2.1', directory: 'packages/operator-agent' },
];

test('recognizes applied changesets when every bumped package changelog changed', () => {
  const currentPackages = [
    { ...previousPackages[0], version: '0.14.2' },
    { ...previousPackages[1], version: '0.14.2' },
    { ...previousPackages[2], version: '0.2.1' },
  ];

  assert.deepEqual(
    findAppliedPackages(previousPackages, currentPackages, [
      'packages/core/CHANGELOG.md',
      'packages/cli/CHANGELOG.md',
    ]),
    ['@agents-ensemble/core', '@agents-ensemble/cli'],
  );
});

test('does not treat root-only or non-version package edits as applied changesets', () => {
  const unchangedVersions = previousPackages.map((pkg) => ({ ...pkg }));

  assert.deepEqual(
    findAppliedPackages(previousPackages, unchangedVersions, [
      'package.json',
      'packages/core/package.json',
    ]),
    [],
  );
});

test('does not treat package version changes without all corresponding changelogs as applied', () => {
  const currentPackages = [
    { ...previousPackages[0], version: '0.14.2' },
    { ...previousPackages[1], version: '0.14.2' },
    previousPackages[2],
  ];

  assert.deepEqual(
    findAppliedPackages(previousPackages, currentPackages, [
      'packages/core/CHANGELOG.md',
    ]),
    [],
  );
});

test('accepts a single independently versioned package with its changelog', () => {
  const currentPackages = [
    previousPackages[0],
    previousPackages[1],
    { ...previousPackages[2], version: '0.2.2' },
  ];

  assert.deepEqual(
    findAppliedPackages(previousPackages, currentPackages, [
      'packages/operator-agent/CHANGELOG.md',
    ]),
    ['@agents-ensemble/operator-agent'],
  );
});

test('keeps an empty initial release push in the missing-changeset failure path', () => {
  assert.equal(
    classifyReleasePush({
      hasChangesets: false,
      skipMarker: false,
      created: true,
      appliedPackages: [],
    }),
    'missing',
  );
});

test('applies pending changesets on an initial release branch push', () => {
  assert.equal(
    classifyReleasePush({
      hasChangesets: true,
      skipMarker: false,
      created: true,
      appliedPackages: [],
    }),
    'apply',
  );
});

test('skips version mutations for a versioned push even when the commit has skip-changeset', () => {
  assert.equal(
    classifyReleasePush({
      hasChangesets: false,
      skipMarker: true,
      created: false,
      appliedPackages: ['@agents-ensemble/core'],
    }),
    'already_versioned',
  );
});

test('keeps later skip-changeset pushes distinct from the initial root-version update path', () => {
  assert.equal(
    classifyReleasePush({
      hasChangesets: false,
      skipMarker: true,
      created: false,
      appliedPackages: [],
    }),
    'skip',
  );
});

test('marks an initial skip-changeset push separately for guarded root version handling', () => {
  assert.equal(
    classifyReleasePush({
      hasChangesets: false,
      skipMarker: true,
      created: true,
      appliedPackages: [],
    }),
    'skip_initial',
  );
});
