import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptPath = fileURLToPath(
  new URL('./migrate-project-ensemble-runtime-to-user.mjs', import.meta.url),
);
const temporaryRoots = [];
const issueUrl = 'https://github.com/Example/Repo/issues/607';

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

test('dry-run inventories copy candidates, unresolved transcripts, and incomplete checkout roots', async () => {
  const root = await makeRoot();
  const { checkoutRoot, userRoot, repoKey, sessionRoot } = root;
  const store = makeStore('dry-run-session', issueUrl, '/old/clone');
  const storePath = join(sessionRoot, 'dry-run-session.json');
  const storeText = `${JSON.stringify(store, null, 2)}\n`;
  const transcriptPath = join(sessionRoot, 'pi', 'unresolved.jsonl');
  const transcriptText = `${JSON.stringify({
    type: 'session',
    id: 'unknown-session',
  })}\n`;
  await mkdir(join(sessionRoot, 'pi'), { recursive: true });
  await writeFile(storePath, storeText, 'utf8');
  await writeFile(transcriptPath, transcriptText, 'utf8');
  await createGitCheckout(checkoutRoot);

  const result = runMigration(root, {
    checkoutRoots: [checkoutRoot],
    complete: false,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const storeEntry = findEntry(manifest, storePath);
  const transcriptEntry = findEntry(manifest, transcriptPath);

  assert.equal(storeEntry.disposition, 'planned-copy');
  assert.equal(storeEntry.evidence.canonicalSlug, 'github.com/example/repo');
  assert.equal(transcriptEntry.disposition, 'unresolved');
  assert.match(transcriptEntry.reason, /No matching SessionResumeStore/u);
  assert.equal(manifest.checkoutInventory.complete, false);
  assert.deepEqual(manifest.checkoutInventory.unconfirmedRoots, [checkoutRoot]);
  assert.equal(
    manifest.checkoutInventory.declaredRoots[0].inventoryConfirmed,
    false,
  );
  assert.equal(await readFile(storePath, 'utf8'), storeText);
  assert.equal(await readFile(transcriptPath, 'utf8'), transcriptText);
  await assert.rejects(
    readFile(join(userRoot, 'sessions', 'github.com', 'example', 'repo', 'dry-run-session.json')),
  );
  assert.equal(repoKey.length, 64);
});

test('apply copies hash and checkout Issue data plus eligible watch bundles, then reruns as no-op', async () => {
  const root = await makeRoot();
  const { checkoutRoot, userRoot, repoKey, sessionRoot, operatorRoot } = root;
  const hashId = 'hash-session';
  const projectId = 'project-session';
  const hashStorePath = join(sessionRoot, `${hashId}.json`);
  const hashSidecarPath = join(
    sessionRoot,
    hashId,
    'open-questions.yaml',
  );
  const hashToolCallsPath = join(sessionRoot, `${hashId}.tool-calls`);
  const hashPiPath = join(sessionRoot, 'pi', 'hash-transcript.jsonl');
  const projectSessions = join(checkoutRoot, '.ensemble', 'sessions');
  const projectStorePath = join(projectSessions, `${projectId}.json`);
  const projectToolCallsPath = join(
    projectSessions,
    `${projectId}.tool-calls`,
  );
  const projectSidecarPath = join(
    projectSessions,
    projectId,
    'session-state.yaml',
  );
  const projectPiPath = join(
    checkoutRoot,
    '.ensemble',
    'pi',
    'sessions',
    'project-transcript.jsonl',
  );
  const sharedLegacyOperatorPiPath = join(
    checkoutRoot,
    '.ensemble',
    'pi',
    'sessions',
    'legacy-operator-transcript.jsonl',
  );
  const hashStoreText = `${JSON.stringify(
    makeStore(hashId, issueUrl, '/different/checkout'),
  )}\n`;
  const projectStoreText = `${JSON.stringify(
    makeStore(projectId, issueUrl, checkoutRoot),
  )}\n`;
  const hashSidecarText = 'version: 1\nsequence: 2\nopenQuestions: []\n';
  const projectSidecarText =
    'version: 2\ncurrent:\n  statusLine: Migrated\nhistory: []\n';
  const projectToolCallsText = '{"worker":"project"}\n';
  const hashToolCallsText = '{"worker":"hash"}\n';
  const hashPiText = `${JSON.stringify({
    type: 'session',
    id: hashId,
    cwd: '/old/clone',
  })}\n{"type":"message"}\n`;
  const projectPiText = `${JSON.stringify({
    type: 'session',
    id: projectId,
    cwd: checkoutRoot,
  })}\n{"type":"message"}\n`;
  const legacyOperatorPiText = `${JSON.stringify({
    type: 'session',
    id: 'legacy-operator',
    cwd: checkoutRoot,
  })}\n{"type":"message"}\n`;

  await createGitCheckout(checkoutRoot);
  await mkdir(join(sessionRoot, hashId), { recursive: true });
  await mkdir(join(sessionRoot, 'pi'), { recursive: true });
  await mkdir(join(projectSessions, projectId), { recursive: true });
  await mkdir(join(checkoutRoot, '.ensemble', 'pi', 'sessions'), {
    recursive: true,
  });
  await writeFile(hashStorePath, hashStoreText, 'utf8');
  await writeFile(hashSidecarPath, hashSidecarText, 'utf8');
  await writeFile(hashToolCallsPath, hashToolCallsText, 'utf8');
  await writeFile(hashPiPath, hashPiText, 'utf8');
  await writeFile(projectStorePath, projectStoreText, 'utf8');
  await writeFile(projectToolCallsPath, projectToolCallsText, 'utf8');
  await writeFile(projectSidecarPath, projectSidecarText, 'utf8');
  await writeFile(projectPiPath, projectPiText, 'utf8');
  await writeFile(sharedLegacyOperatorPiPath, legacyOperatorPiText, 'utf8');

  const hashWatchPath = join(operatorRoot, 'watch-state.json');
  const projectWatchPath = join(
    checkoutRoot,
    '.ensemble',
    'operator-agent',
    'watch-state.json',
  );
  const hashWatch = makeWatchState(hashId, issueUrl, 5);
  const projectWatch = makeWatchState(projectId, issueUrl, 8);
  await mkdir(operatorRoot, { recursive: true });
  await mkdir(join(checkoutRoot, '.ensemble', 'operator-agent'), {
    recursive: true,
  });
  await writeJson(hashWatchPath, hashWatch);
  await writeJson(projectWatchPath, projectWatch);

  const oldOperatorConversation = join(operatorRoot, 'session.json');
  const oldOperatorTranscript = join(operatorRoot, 'pi-sessions', 'old.jsonl');
  await mkdir(join(operatorRoot, 'pi-sessions'), { recursive: true });
  await writeJson(oldOperatorConversation, { agentId: 'old-operator' });
  await writeFile(oldOperatorTranscript, '{"type":"session","id":"old-operator"}\n');
  const projectOperatorConversation = join(
    checkoutRoot,
    '.ensemble',
    'operator-agent',
    'session.json',
  );
  await writeJson(projectOperatorConversation, {
    agentId: 'legacy-operator',
    backend: 'pi',
    repoRoot: checkoutRoot,
  });

  const sourceSnapshots = new Map(
    [
      hashStorePath,
      hashSidecarPath,
      hashToolCallsPath,
      hashPiPath,
      projectStorePath,
      projectToolCallsPath,
      projectSidecarPath,
      projectPiPath,
      sharedLegacyOperatorPiPath,
      hashWatchPath,
      projectWatchPath,
    ].map((path, index) => [
      path,
      [
        hashStoreText,
        hashSidecarText,
        hashToolCallsText,
        hashPiText,
        projectStoreText,
        projectToolCallsText,
        projectSidecarText,
        projectPiText,
        legacyOperatorPiText,
        `${JSON.stringify(hashWatch, null, 2)}\n`,
        `${JSON.stringify(projectWatch, null, 2)}\n`,
      ][index],
    ]),
  );

  const apply = runMigration(root, {
    checkoutRoots: [checkoutRoot],
    complete: true,
    profile: 'personal',
    apply: true,
  });
  assert.equal(apply.status, 0, apply.stderr);
  let manifest = await readManifest(root);

  const slugRoot = join(userRoot, 'sessions', 'github.com', 'example', 'repo');
  assert.equal(
    await readFile(join(slugRoot, `${hashId}.json`), 'utf8'),
    hashStoreText,
  );
  assert.equal(
    await readFile(join(slugRoot, hashId, 'open-questions.yaml'), 'utf8'),
    hashSidecarText,
  );
  assert.equal(
    await readFile(join(slugRoot, `${hashId}.tool-calls`), 'utf8'),
    hashToolCallsText,
  );
  assert.equal(
    await readFile(join(slugRoot, 'pi', 'hash-transcript.jsonl'), 'utf8'),
    hashPiText,
  );
  assert.equal(
    await readFile(join(slugRoot, `${projectId}.json`), 'utf8'),
    projectStoreText,
  );
  assert.equal(
    await readFile(join(slugRoot, `${projectId}.tool-calls`), 'utf8'),
    projectToolCallsText,
  );
  assert.equal(
    await readFile(
      join(slugRoot, projectId, 'session-state.yaml'),
      'utf8',
    ),
    projectSidecarText,
  );
  assert.equal(
    await readFile(join(slugRoot, 'pi', 'project-transcript.jsonl'), 'utf8'),
    projectPiText,
  );
  assert.equal(
    await readFile(hashStorePath, 'utf8'),
    sourceSnapshots.get(hashStorePath),
  );
  for (const [source, contents] of sourceSnapshots) {
    assert.equal(await readFile(source, 'utf8'), contents, source);
  }

  const watchDestination = join(
    userRoot,
    'operator-agents',
    'personal',
    'watch',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const migratedWatch = JSON.parse(await readFile(watchDestination, 'utf8'));
  assert.deepEqual(Object.keys(migratedWatch.watches).sort(), [
    hashId,
    projectId,
  ]);
  assert.equal(migratedWatch.cursors[hashId].sequence, 5);
  assert.equal(migratedWatch.messageListeners[hashId].messageDebounceMs, 1000);
  assert.equal(migratedWatch.messageCursors[hashId], 7);
  assert.equal(migratedWatch.pendingReports[0].issueUrl, issueUrl);
  assert.equal(
    manifest.entries.find(
      (entry) => entry.source === oldOperatorConversation,
    ),
    undefined,
  );
  assert.equal(
    manifest.entries.find(
      (entry) => entry.source === oldOperatorTranscript,
    ),
    undefined,
  );
  assert.equal(
    manifest.entries.find(
      (entry) => entry.source === projectOperatorConversation,
    ),
    undefined,
  );
  assert.equal(
    manifest.entries.find(
      (entry) => entry.source === sharedLegacyOperatorPiPath,
    ),
    undefined,
  );
  assert.equal(manifest.checkoutInventory.complete, true);
  const firstManifestPath = root.manifestPath;
  assert.ok(
    manifest.entries.every(
      (entry) =>
        !entry.source?.includes('/operator-agent/session.json') &&
        !entry.source?.includes('/pi-sessions/'),
    ),
  );

  const rerun = runMigration(root, {
    checkoutRoots: [checkoutRoot],
    complete: true,
    profile: 'personal',
    apply: true,
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  manifest = await readManifest(root);
  assert.equal(await fileExists(firstManifestPath), true);
  assert.ok(
    manifest.entries
      .filter((entry) => entry.source && entry.destination)
      .every((entry) => entry.disposition === 'no-op-identical'),
  );
  assert.equal(manifest.summary.copied ?? 0, 0);
  assert.equal(manifest.summary.collision ?? 0, 0);
  assert.equal(repoKey.length, 64);
});

test('different destinations are preserved and conflicting watch bundles are archived with recovery data', async () => {
  const root = await makeRoot();
  const { userRoot, repoKey, sessionRoot, operatorRoot } = root;
  const agentId = 'collision-session';
  const storePath = join(sessionRoot, `${agentId}.json`);
  const storeText = `${JSON.stringify(makeStore(agentId, issueUrl, '/old'))}\n`;
  const sourceWatchPath = join(operatorRoot, 'watch-state.json');
  const targetWatchPath = join(
    userRoot,
    'operator-agents',
    'personal',
    'watch',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const conflictingWatch = makeWatchState('other-session', issueUrl, 2);

  await mkdir(sessionRoot, { recursive: true });
  await writeFile(storePath, storeText, 'utf8');
  await mkdir(dirname(targetWatchPath), { recursive: true });
  await mkdir(operatorRoot, { recursive: true });
  await writeJson(sourceWatchPath, makeWatchState(agentId, issueUrl, 1));
  const storeDestination = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${agentId}.json`,
  );
  await mkdir(dirname(storeDestination), { recursive: true });
  await writeJson(storeDestination, {
    ...makeStore(agentId, issueUrl, '/new'),
    updatedAt: 99,
  });
  await writeJson(targetWatchPath, conflictingWatch);

  const result = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const storeEntry = findEntry(manifest, storePath);
  const watchEntry = findEntry(manifest, sourceWatchPath);

  assert.equal(storeEntry.disposition, 'collision');
  assert.match(storeEntry.collisionReason, /different checksum/u);
  assert.equal(
    await readFile(storeDestination, 'utf8'),
    `${JSON.stringify({
      ...makeStore(agentId, issueUrl, '/new'),
      updatedAt: 99,
    }, null, 2)}\n`,
  );
  assert.equal(watchEntry.disposition, 'archived');
  assert.match(watchEntry.archiveReason, /cannot be overwritten/u);
  assert.ok(watchEntry.sourceSha256);
  assert.ok(watchEntry.sourceBundleSha256);
  assert.ok(watchEntry.destinationSha256);
  assert.equal(watchEntry.evidence.operatorSelectedProfile, 'personal');
  assert.match(watchEntry.destination, /operator-agents\/legacy\/watch\//u);
  assert.ok(await fileExists(watchEntry.destination));
  assert.equal(
    await readFile(sourceWatchPath, 'utf8'),
    `${JSON.stringify(makeWatchState(agentId, issueUrl, 1), null, 2)}\n`,
  );
  assert.notEqual(repoKey, '');
});

test('pending report URL mismatch is archived and never assigned to the profile slug', async () => {
  const root = await makeRoot();
  const { userRoot, sessionRoot, operatorRoot } = root;
  const agentId = 'mismatched-report';
  const storePath = join(sessionRoot, `${agentId}.json`);
  const watchPath = join(operatorRoot, 'watch-state.json');
  await writeJson(storePath, makeStore(agentId, issueUrl, '/old'));
  await mkdir(operatorRoot, { recursive: true });
  await writeJson(
    watchPath,
    makeWatchState(
      agentId,
      'https://github.com/example/repo/issues/999',
      3,
    ),
  );

  const result = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const watchEntry = findEntry(manifest, watchPath);
  assert.equal(watchEntry.disposition, 'archived');
  assert.match(watchEntry.archiveReason, /differs from/u);
  assert.equal(
    await fileExists(
      join(
        userRoot,
        'operator-agents',
        'personal',
        'watch',
        'github.com',
        'example',
        'repo',
        'watch-state.json',
      ),
    ),
    false,
  );
  assert.equal(await fileExists(watchPath), true);
});

test('a canonical slug Store can prove an old hash watch bundle destination', async () => {
  const root = await makeRoot();
  const { userRoot, operatorRoot } = root;
  const agentId = 'canonical-store-watch';
  const canonicalStorePath = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${agentId}.json`,
  );
  const watchPath = join(operatorRoot, 'watch-state.json');
  await writeJson(canonicalStorePath, makeStore(agentId, issueUrl, '/old'));
  await mkdir(operatorRoot, { recursive: true });
  await writeJson(watchPath, makeWatchState(agentId, issueUrl, 4));

  const result = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const watchEntry = findEntry(manifest, watchPath);
  assert.equal(watchEntry.disposition, 'copied');
  assert.deepEqual(watchEntry.evidence.sessionStoreSources, [
    canonicalStorePath,
  ]);
  assert.equal(
    await fileExists(
      join(
        userRoot,
        'operator-agents',
        'personal',
        'watch',
        'github.com',
        'example',
        'repo',
        'watch-state.json',
      ),
    ),
    true,
  );
});

function makeStore(conductorAgentId, storeIssueUrl, repoRoot) {
  return {
    version: 1,
    conductorAgentId,
    issueUrl: storeIssueUrl,
    repoRoot,
    profile: { workers: [] },
    openQuestions: [],
    sequence: 0,
    workers: {},
    updatedAt: 10,
  };
}

function makeWatchState(conductorAgentId, reportIssueUrl, sequence) {
  return {
    version: 1,
    watches: {
      [conductorAgentId]: {
        conductorAgentId,
        pollIntervalMs: 30_000,
        debounceMs: 0,
      },
    },
    cursors: {
      [conductorAgentId]: {
        sequence,
        questionFingerprints: {},
        statusFingerprints: {},
      },
    },
    messageListeners: {
      [conductorAgentId]: {
        conductorAgentId,
        messageDebounceMs: 1000,
      },
    },
    messageCursors: { [conductorAgentId]: 7 },
    pendingReports: [
      {
        reportId: `${conductorAgentId}-report`,
        reportType: 'open_question',
        conductorAgentId,
        issueUrl: reportIssueUrl,
        text: 'Pending report',
        debounceMs: 0,
      },
    ],
  };
}

async function makeRoot() {
  const path = await mkdtemp(join(tmpdir(), 'ensemble-runtime-migration-'));
  temporaryRoots.push(path);
  const checkoutRoot = join(path, 'checkout');
  const userRoot = join(path, 'user');
  const repoKey = createHash('sha256')
    .update(resolve(checkoutRoot))
    .digest('hex');
  const sessionRoot = join(userRoot, 'sessions', repoKey);
  const operatorRoot = join(userRoot, 'operator-agent', repoKey);
  return {
    path,
    checkoutRoot,
    userRoot,
    repoKey,
    sessionRoot,
    operatorRoot,
    manifestRun: 0,
  };
}

async function createGitCheckout(checkoutRoot) {
  await mkdir(join(checkoutRoot, '.git'), { recursive: true });
  await mkdir(join(checkoutRoot, '.ensemble'), { recursive: true });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runMigration(
  root,
  {
    checkoutRoots = [],
    complete = false,
    profile,
    apply = false,
  } = {},
) {
  root.manifestRun += 1;
  root.manifestPath = join(
    root.path,
    `migration-manifest-${root.manifestRun}.json`,
  );
  const args = [
    scriptPath,
    '--user-root',
    root.userRoot,
    '--manifest',
    root.manifestPath,
    ...(apply ? ['--apply'] : ['--dry-run']),
  ];
  for (const checkoutRoot of checkoutRoots) {
    args.push('--checkout-root', checkoutRoot);
  }
  if (complete) args.push('--checkout-roots-complete');
  if (profile) args.push('--profile', profile);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

async function readManifest(root) {
  return JSON.parse(await readFile(root.manifestPath, 'utf8'));
}

function findEntry(manifest, source) {
  const matches = manifest.entries.filter((entry) => entry.source === source);
  assert.equal(
    matches.length,
    1,
    `expected one manifest entry for ${source}, found ${matches.length}`,
  );
  return matches[0];
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
