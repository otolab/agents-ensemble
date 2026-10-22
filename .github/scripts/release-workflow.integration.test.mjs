import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createOrFindReleasePr } from './ensure-release-pr.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, '../..');
const classifierPath = path.join(scriptsDirectory, 'release-version-state.mjs');
const workflowPath = path.join(repoRoot, '.github/workflows/version-update.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const initialRef = '0000000000000000000000000000000000000000';

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writePackage(directory, name, version, { private: isPrivate = false } = {}) {
  const packageDirectory = path.join(directory, 'packages', name.split('/').at(-1));
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify({ name, version, private: isPrivate }, null, 2)}\n`,
  );
  writeFileSync(path.join(packageDirectory, 'CHANGELOG.md'), `# ${version}\n`);
}

function createRepository(t, { withChangeset = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'release-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  run(directory, 'git', ['init', '--quiet']);
  run(directory, 'git', ['checkout', '-b', 'release/1.2.3']);
  run(directory, 'git', ['config', 'user.name', 'Workflow Test']);
  run(directory, 'git', ['config', 'user.email', 'workflow-test@example.invalid']);

  writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'agents-ensemble', version: '1.2.3', private: true }, null, 2)}\n`,
  );
  writePackage(directory, '@agents-ensemble/core', '0.14.1');
  writePackage(directory, '@agents-ensemble/cli', '0.14.1');
  writePackage(directory, '@agents-ensemble/operator-agent', '0.2.1');
  mkdirSync(path.join(directory, '.changeset'), { recursive: true });
  writeFileSync(path.join(directory, '.changeset/README.md'), '# Changesets\n');
  if (withChangeset) {
    writeFileSync(path.join(directory, '.changeset/pending.md'), '---\n"@agents-ensemble/core": patch\n---\n');
  }
  run(directory, 'git', ['add', '-A']);
  run(directory, 'git', ['commit', '-m', 'fixture: initial release state']);
  const before = run(directory, 'git', ['rev-parse', 'HEAD']);

  return { directory, before };
}

function commitAll(directory, message) {
  run(directory, 'git', ['add', '-A']);
  run(directory, 'git', ['commit', '-m', message]);
  return run(directory, 'git', ['rev-parse', 'HEAD']);
}

function runClassifier({ directory, before, head, created }) {
  const outputPath = path.join(directory, 'github-output.txt');
  writeFileSync(outputPath, '');
  const result = spawnSync(
    process.execPath,
    [
      classifierPath,
      before,
      head,
      String(created),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const outputs = Object.fromEntries(
    readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { outputs, stdout: result.stdout, stderr: result.stderr };
}

function workflowCondition(stepName) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(new RegExp(`- name: ${escapedName}\\n\\s+if: ([^\\n]+)`));
  assert.ok(match, `Missing workflow condition for "${stepName}"`);
  return match[1].trim();
}

function assertWorkflowOutputContract() {
  assert.equal(
    workflowCondition('Apply version updates'),
    "steps.changesets.outputs.apply_version_updates == 'true'",
  );
  assert.equal(
    workflowCondition('Update root version only (when skipping changeset)'),
    "steps.changesets.outputs.update_root_version == 'true'",
  );
  assert.equal(
    workflowCondition('Create or find Release PR'),
    "steps.changesets.outputs.create_release_pr == 'true'",
  );
  assert.equal(
    workflowCondition('No changesets found'),
    "steps.changesets.outputs.missing_changesets == 'true'",
  );
  assert.match(workflow, /node \.github\/scripts\/release-version-state\.mjs/);
  assert.match(workflow, /node \.github\/scripts\/ensure-release-pr\.mjs/);
}

test('versioned push passes workflow outputs through Release PR creation and existing PR detection', async (t) => {
  const { directory, before } = createRepository(t, { withChangeset: true });
  for (const [name, version] of [
    ['core', '0.14.2'],
    ['cli', '0.14.2'],
    ['operator-agent', '0.2.2'],
  ]) {
    writePackage(directory, `@agents-ensemble/${name}`, version);
  }
  rmSync(path.join(directory, '.changeset/pending.md'));
  const head = commitAll(directory, 'chore: apply changesets locally');

  const { outputs } = runClassifier({
    directory,
    before,
    head,
    created: false,
  });
  assert.equal(outputs.release_mode, 'already_versioned');
  assert.equal(outputs.apply_version_updates, 'false');
  assert.equal(outputs.update_root_version, 'false');
  assert.equal(outputs.create_release_pr, 'true');
  assert.equal(outputs.missing_changesets, 'false');
  assertWorkflowOutputContract();

  const createdCalls = [];
  const created = await createOrFindReleasePr({
    branchName: 'release/1.2.3',
    version: '1.2.3',
    skipChangeset: false,
    github: {
      findByHead: async (headName) => {
        createdCalls.push(['find', headName]);
        return undefined;
      },
      create: async (request) => createdCalls.push(['create', request]),
    },
  });
  assert.deepEqual(created, { action: 'created' });
  assert.equal(createdCalls[0][0], 'find');
  assert.equal(createdCalls[1][0], 'create');
  assert.equal(createdCalls[1][1].head, 'release/1.2.3');

  const existingCalls = [];
  const existing = await createOrFindReleasePr({
    branchName: 'release/1.2.3',
    version: '1.2.3',
    skipChangeset: false,
    github: {
      findByHead: async (headName) => {
        existingCalls.push(['find', headName]);
        return 42;
      },
      create: async (request) => existingCalls.push(['create', request]),
    },
  });
  assert.deepEqual(existing, { action: 'found', number: '42' });
  assert.deepEqual(existingCalls, [['find', 'release/1.2.3']]);
});

test('initial missing changesets, root-only changes, and ordinary skip pushes retain distinct outputs', (t) => {
  const pendingChangeset = createRepository(t, { withChangeset: true });
  const applyOutputs = runClassifier({
    directory: pendingChangeset.directory,
    before: initialRef,
    head: pendingChangeset.before,
    created: true,
  }).outputs;
  assert.equal(applyOutputs.release_mode, 'apply');
  assert.equal(applyOutputs.apply_version_updates, 'true');
  assert.equal(applyOutputs.missing_changesets, 'false');

  const initial = createRepository(t);
  const initialOutputs = runClassifier({
    directory: initial.directory,
    before: initialRef,
    head: initial.before,
    created: true,
  }).outputs;
  assert.equal(initialOutputs.release_mode, 'missing');
  assert.equal(initialOutputs.missing_changesets, 'true');
  assert.equal(initialOutputs.create_release_pr, 'false');

  const rootOnly = createRepository(t);
  writeFileSync(
    path.join(rootOnly.directory, 'package.json'),
    `${JSON.stringify({ name: 'agents-ensemble', version: '1.2.4', private: true }, null, 2)}\n`,
  );
  const rootHead = commitAll(rootOnly.directory, 'chore: update root version');
  const rootOutputs = runClassifier({
    directory: rootOnly.directory,
    before: rootOnly.before,
    head: rootHead,
    created: false,
  }).outputs;
  assert.equal(rootOutputs.release_mode, 'missing');
  assert.equal(rootOutputs.already_versioned, 'false');

  const skip = createRepository(t);
  writeFileSync(path.join(skip.directory, 'docs.md'), 'documentation only\n');
  const skipHead = commitAll(skip.directory, 'docs: update release guide [skip-changeset]');
  const skipOutputs = runClassifier({
    directory: skip.directory,
    before: skip.before,
    head: skipHead,
    created: false,
  }).outputs;
  assert.equal(skipOutputs.release_mode, 'skip');
  assert.equal(skipOutputs.update_root_version, 'false');
  assert.equal(skipOutputs.create_release_pr, 'true');
});

test('fails closed when a new package manifest is absent from the previous ref', (t) => {
  const { directory, before } = createRepository(t, { withChangeset: true });
  writePackage(directory, '@agents-ensemble/core', '0.14.2');
  writeFileSync(path.join(directory, 'packages/core/CHANGELOG.md'), '# 0.14.2\n');
  writePackage(directory, '@agents-ensemble/new-package', '0.1.0');
  rmSync(path.join(directory, '.changeset/pending.md'));
  const head = commitAll(directory, 'chore: apply changeset and add package');

  const { outputs, stderr } = runClassifier({
    directory,
    before,
    head,
    created: false,
  });
  assert.equal(outputs.release_mode, 'missing');
  assert.equal(outputs.already_versioned, 'false');
  assert.equal(outputs.create_release_pr, 'false');
  assert.match(stderr, /refusing already-versioned classification/);
});
