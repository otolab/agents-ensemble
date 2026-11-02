import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptPath = fileURLToPath(
  new URL('./migrate-project-ensemble-runtime-to-user.mjs', import.meta.url),
);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

test('mirrors migrated session stores and sidecars to slug without changing hash data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-runtime-migration-'));
  temporaryRoots.push(root);
  const repoRoot = join(root, 'repository');
  const userRoot = join(root, 'user');
  const agentId = 'migrated-session';
  const issueUrl = 'https://github.com/Example/Repo/issues/607';
  const projectSession = join(
    repoRoot,
    '.ensemble',
    'sessions',
    `${agentId}.json`,
  );
  const projectSessionDir = join(
    repoRoot,
    '.ensemble',
    'sessions',
    agentId,
  );
  const resumeStoreText = `${JSON.stringify({
    version: 1,
    conductorAgentId: agentId,
    issueUrl,
    repoRoot,
    profile: { workers: [] },
    openQuestions: [],
    sequence: 0,
    workers: {},
    updatedAt: 10,
  })}\n`;
  const openQuestionsText = 'version: 1\nsequence: 1\nopenQuestions: []\n';
  const sessionStateText =
    'version: 2\ncurrent:\n  statusLine: Migrated\n  reportedAt: 10\nhistory: []\n';
  await mkdir(projectSessionDir, { recursive: true });
  await writeFile(projectSession, resumeStoreText, 'utf8');
  await writeFile(
    join(projectSessionDir, 'open-questions.yaml'),
    openQuestionsText,
    'utf8',
  );
  await writeFile(
    join(projectSessionDir, 'session-state.yaml'),
    sessionStateText,
    'utf8',
  );

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--repo-root', repoRoot],
    {
      encoding: 'utf8',
      env: { ...process.env, ENSEMBLE_USER_ROOT: userRoot },
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const hashRoot = join(
    userRoot,
    'sessions',
    createPathHash(repoRoot),
  );
  const slugRoot = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
  );
  const hashResumeStore = join(hashRoot, `${agentId}.json`);
  const slugResumeStore = join(slugRoot, `${agentId}.json`);
  const hashOpenQuestions = join(
    hashRoot,
    agentId,
    'open-questions.yaml',
  );
  const slugOpenQuestions = join(
    slugRoot,
    agentId,
    'open-questions.yaml',
  );
  const hashSessionState = join(hashRoot, agentId, 'session-state.yaml');
  const slugSessionState = join(slugRoot, agentId, 'session-state.yaml');

  assert.equal(await readFile(hashResumeStore, 'utf8'), resumeStoreText);
  assert.equal(await readFile(slugResumeStore, 'utf8'), resumeStoreText);
  assert.equal(await readFile(hashOpenQuestions, 'utf8'), openQuestionsText);
  assert.equal(await readFile(slugOpenQuestions, 'utf8'), openQuestionsText);
  assert.equal(await readFile(hashSessionState, 'utf8'), sessionStateText);
  assert.equal(await readFile(slugSessionState, 'utf8'), sessionStateText);

  await rm(slugRoot, { recursive: true, force: true });
  const rerunAfterHashMigration = spawnSync(
    process.execPath,
    [scriptPath, '--repo-root', repoRoot],
    {
      encoding: 'utf8',
      env: { ...process.env, ENSEMBLE_USER_ROOT: userRoot },
    },
  );
  assert.equal(rerunAfterHashMigration.status, 0, rerunAfterHashMigration.stderr);
  assert.equal(await readFile(hashResumeStore, 'utf8'), resumeStoreText);
  assert.equal(await readFile(slugResumeStore, 'utf8'), resumeStoreText);
  assert.equal(await readFile(slugOpenQuestions, 'utf8'), openQuestionsText);
  assert.equal(await readFile(slugSessionState, 'utf8'), sessionStateText);

  const canonicalResumeStore = `${JSON.stringify({
    ...JSON.parse(resumeStoreText),
    updatedAt: 99,
  })}\n`;
  await writeFile(slugResumeStore, canonicalResumeStore, 'utf8');
  const rerun = spawnSync(
    process.execPath,
    [scriptPath, '--repo-root', repoRoot],
    {
      encoding: 'utf8',
      env: { ...process.env, ENSEMBLE_USER_ROOT: userRoot },
    },
  );
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(await readFile(hashResumeStore, 'utf8'), resumeStoreText);
  assert.equal(await readFile(slugResumeStore, 'utf8'), canonicalResumeStore);
});

function createPathHash(repoRoot) {
  return createHash('sha256').update(repoRoot).digest('hex');
}
