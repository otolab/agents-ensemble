import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readFile,
  readdir,
  rm,
  symlink,
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

test('an empty checkout list remains unconfirmed despite the complete assertion', async () => {
  const root = await makeRoot();
  const result = runMigration(root, { complete: true });
  assert.equal(result.status, 0, result.stderr);

  const manifest = await readManifest(root);
  assert.deepEqual(manifest.checkoutInventory.declaredRoots, []);
  assert.equal(
    manifest.checkoutInventory.operatorAssertedComplete,
    true,
  );
  assert.equal(manifest.checkoutInventory.scanCompleted, true);
  assert.equal(manifest.checkoutInventory.complete, false);
  assert.equal(
    manifest.checkoutInventory.completeness,
    'empty-inventory-unverified',
  );
  assert.deepEqual(manifest.checkoutInventory.unconfirmedRoots, [
    '<no checkout roots declared>',
  ]);
});

test('complete checkout inventory retains failed root and source scan evidence', async () => {
  const root = await makeRoot();
  const missingCheckoutRoot = join(root.path, 'missing-checkout');
  const sourceErrorCheckoutRoot = join(root.path, 'source-error-checkout');
  const sourceDirectory = join(
    sourceErrorCheckoutRoot,
    '.ensemble',
    'sessions',
  );
  await createGitCheckout(sourceErrorCheckoutRoot);
  await writeFile(sourceDirectory, 'blocked-by-file\n', 'utf8');

  const result = runMigration(root, {
    checkoutRoots: [missingCheckoutRoot, sourceErrorCheckoutRoot],
    complete: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const missingRootRecord = manifest.checkoutInventory.declaredRoots.find(
    (entry) => entry.path === missingCheckoutRoot,
  );
  const sourceError = findEntry(manifest, sourceDirectory);

  assert.equal(manifest.checkoutInventory.complete, true);
  assert.equal(manifest.checkoutInventory.scanCompleted, true);
  assert.deepEqual(manifest.checkoutInventory.unresolvedRoots, [
    missingCheckoutRoot,
  ]);
  assert.equal(missingRootRecord.disposition, 'unresolved');
  assert.match(missingRootRecord.reason, /does not exist as a directory/u);
  assert.equal(sourceError.disposition, 'unresolved');
  assert.match(sourceError.reason, /Expected a regular directory/u);
  assert.equal(
    sourceError.provenance.checkoutRoot,
    sourceErrorCheckoutRoot,
  );
});

test('fatal checkout scan errors retain every later declared root as unscanned', async () => {
  const root = await makeRoot();
  const completedCheckout = join(root.path, 'completed-checkout');
  const blockedCheckout = join(root.path, 'blocked-checkout');
  const laterCheckout = join(root.path, 'later-checkout');
  const blockedMarker = join(blockedCheckout, '.git');
  await createGitCheckout(completedCheckout);
  await createGitCheckout(blockedCheckout);
  await createGitCheckout(laterCheckout);

  const sourceId = 'must-not-copy-after-fatal-scan';
  const sourcePath = join(root.sessionRoot, `${sourceId}.json`);
  const sourceText = `${JSON.stringify(
    makeStore(sourceId, issueUrl, '/old/clone'),
  )}\n`;
  await mkdir(root.sessionRoot, { recursive: true });
  await writeFile(sourcePath, sourceText, 'utf8');

  const preloadPath = join(root.path, 'inject-fatal-lstat.mjs');
  await writeFile(
    preloadPath,
    [
      "import fs from 'node:fs/promises';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalLstat = fs.lstat;',
      `const targetPath = ${JSON.stringify(blockedMarker)};`,
      'fs.lstat = async (path, ...args) => {',
      '  if (String(path) === targetPath) {',
      "    const error = new Error('Injected nonrecoverable scan failure.');",
      "    Object.assign(error, { code: 'ENXIO', errno: -6, syscall: 'lstat', path: targetPath });",
      '    throw error;',
      '  }',
      '  return originalLstat.call(fs, path, ...args);',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = runMigration(root, {
    checkoutRoots: [completedCheckout, blockedCheckout, laterCheckout],
    complete: true,
    apply: true,
    preloadPath,
  });
  assert.notEqual(result.status, 0, result.stdout);

  const manifest = await readManifest(root);
  const completedRecord = manifest.checkoutInventory.declaredRoots.find(
    (entry) => entry.path === completedCheckout,
  );
  const blockedRecord = manifest.checkoutInventory.declaredRoots.find(
    (entry) => entry.path === blockedCheckout,
  );
  const laterRecord = manifest.checkoutInventory.declaredRoots.find(
    (entry) => entry.path === laterCheckout,
  );
  const destination = join(
    root.userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${sourceId}.json`,
  );

  assert.equal(manifest.checkoutInventory.declaredRoots.length, 3);
  assert.equal(manifest.checkoutInventory.complete, false);
  assert.equal(manifest.checkoutInventory.scanCompleted, false);
  assert.equal(
    manifest.checkoutInventory.completeness,
    'operator-asserted-scan-incomplete',
  );
  assert.deepEqual(
    manifest.checkoutInventory.declaredRoots.map((entry) => entry.path),
    [completedCheckout, blockedCheckout, laterCheckout],
  );
  assert.equal(manifest.failure.phase, 'scan');
  assert.equal(manifest.failure.error.code, 'ENXIO');
  assert.equal(manifest.failure.error.syscall, 'lstat');
  assert.equal(manifest.failure.error.path, blockedMarker);
  assert.equal(completedRecord.disposition, 'scanned');
  assert.equal(completedRecord.inventoryConfirmed, true);
  assert.equal(
    manifest.checkoutInventory.unconfirmedRoots.includes(completedCheckout),
    false,
  );
  assert.equal(blockedRecord.disposition, 'unresolved');
  assert.equal(blockedRecord.inventoryConfirmed, false);
  assert.equal(blockedRecord.error.code, 'ENXIO');
  assert.equal(blockedRecord.error.syscall, 'lstat');
  assert.equal(blockedRecord.error.path, blockedMarker);
  assert.equal(
    blockedRecord.provenance.checkoutRoot,
    blockedCheckout,
  );
  assert.ok(blockedRecord.recovery);
  assert.equal(laterRecord.disposition, 'not-scanned');
  assert.equal(laterRecord.inventoryConfirmed, false);
  assert.match(laterRecord.reason, /earlier scan error aborted inventory/u);
  assert.equal(laterRecord.notScannedDueTo.path, blockedMarker);
  assert.equal(laterRecord.notScannedDueTo.code, 'ENXIO');
  assert.equal(laterRecord.provenance.checkoutRoot, laterCheckout);
  assert.ok(laterRecord.recovery);
  assert.deepEqual(
    manifest.checkoutInventory.unconfirmedRoots,
    [blockedCheckout, laterCheckout],
  );
  assert.deepEqual(manifest.checkoutInventory.unresolvedRoots, [
    blockedCheckout,
    laterCheckout,
  ]);
  assert.equal(findEntry(manifest, sourcePath).disposition, 'pending');
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText);
  await assert.rejects(readFile(destination));
});

test('recoverable EACCES scan errors persist unresolved root and source evidence before apply', async (t) => {
  const root = await makeRoot();
  const rootBlockedCheckout = join(root.path, 'root-blocked-checkout');
  const sourceBlockedCheckout = join(root.path, 'source-blocked-checkout');
  const sourceDirectory = join(
    sourceBlockedCheckout,
    '.ensemble',
    'sessions',
  );
  await createGitCheckout(rootBlockedCheckout);
  await createGitCheckout(sourceBlockedCheckout);

  const sourceId = 'permission-blocked-session';
  const blockedStorePath = join(sourceDirectory, `${sourceId}.json`);
  await mkdir(sourceDirectory, { recursive: true });
  const blockedStoreText = `${JSON.stringify(
    makeStore(sourceId, issueUrl, '/old/clone'),
  )}\n`;
  await writeFile(blockedStorePath, blockedStoreText, 'utf8');

  const knownSourceId = 'known-readable-session';
  const knownSourcePath = join(root.sessionRoot, `${knownSourceId}.json`);
  const knownSourceText = `${JSON.stringify(
    makeStore(knownSourceId, issueUrl, '/old/clone'),
  )}\n`;
  await mkdir(root.sessionRoot, { recursive: true });
  await writeFile(knownSourcePath, knownSourceText, 'utf8');

  await chmod(rootBlockedCheckout, 0);
  await chmod(join(sourceBlockedCheckout, '.ensemble'), 0);
  const deniedPaths = await Promise.all(
    [
      join(rootBlockedCheckout, '.git'),
      sourceDirectory,
    ].map(async (path) => {
      try {
        await lstat(path);
        return false;
      } catch (error) {
        return ['EACCES', 'EPERM'].includes(error?.code);
      }
    }),
  );
  if (deniedPaths.some((denied) => !denied)) {
    await chmod(rootBlockedCheckout, 0o700);
    await chmod(join(sourceBlockedCheckout, '.ensemble'), 0o700);
    t.skip('filesystem permissions do not deny lstat for this process');
    return;
  }

  let result;
  try {
    result = runMigration(root, {
      checkoutRoots: [rootBlockedCheckout, sourceBlockedCheckout],
      complete: true,
      apply: true,
    });
  } finally {
    await chmod(rootBlockedCheckout, 0o700);
    await chmod(join(sourceBlockedCheckout, '.ensemble'), 0o700);
  }

  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const rootMarkerEntry = findEntry(
    manifest,
    join(rootBlockedCheckout, '.git'),
  );
  const sourceEntry = findEntry(manifest, sourceDirectory);
  const rootMarkerRecord = manifest.checkoutInventory.declaredRoots.find(
    (entry) => entry.path === rootBlockedCheckout,
  );
  const sourceRootRecord = manifest.checkoutInventory.declaredRoots.find(
    (entry) => entry.path === sourceBlockedCheckout,
  );
  const knownDestination = join(
    root.userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${knownSourceId}.json`,
  );

  assert.equal(manifest.checkoutInventory.complete, true);
  assert.equal(manifest.checkoutInventory.scanCompleted, true);
  assert.ok(
    manifest.checkoutInventory.unresolvedRoots.includes(rootBlockedCheckout),
  );
  assert.ok(
    manifest.checkoutInventory.unresolvedRoots.includes(
      sourceBlockedCheckout,
    ),
  );
  assert.ok(
    manifest.checkoutInventory.unconfirmedRoots.includes(rootBlockedCheckout),
  );
  assert.ok(
    manifest.checkoutInventory.unconfirmedRoots.includes(
      sourceBlockedCheckout,
    ),
  );
  assert.equal(rootMarkerRecord.disposition, 'unresolved');
  assert.equal(rootMarkerRecord.inventoryConfirmed, false);
  assert.ok(['EACCES', 'EPERM'].includes(rootMarkerRecord.error.code));
  assert.equal(rootMarkerRecord.provenance.checkoutRoot, rootBlockedCheckout);
  assert.equal(rootMarkerEntry.disposition, 'unresolved');
  assert.ok(['EACCES', 'EPERM'].includes(rootMarkerEntry.error.code));
  assert.equal(rootMarkerEntry.error.syscall, 'lstat');
  assert.ok(Number.isInteger(rootMarkerEntry.error.errno));
  assert.equal(rootMarkerEntry.provenance.checkoutRoot, rootBlockedCheckout);
  assert.equal(
    rootMarkerEntry.provenance.checkoutRootInventoryConfirmed,
    false,
  );
  assert.ok(rootMarkerEntry.recovery);

  assert.equal(sourceRootRecord.disposition, 'scanned');
  assert.equal(sourceRootRecord.inventoryConfirmed, false);
  assert.ok(
    sourceRootRecord.scanErrors.some(
      (error) =>
        ['EACCES', 'EPERM'].includes(error.code) &&
        error.path === sourceDirectory,
    ),
  );
  assert.equal(sourceEntry.disposition, 'unresolved');
  assert.ok(['EACCES', 'EPERM'].includes(sourceEntry.error.code));
  assert.equal(sourceEntry.error.syscall, 'lstat');
  assert.ok(Number.isInteger(sourceEntry.error.errno));
  assert.equal(sourceEntry.provenance.checkoutRoot, sourceBlockedCheckout);
  assert.equal(sourceEntry.provenance.checkoutRootInventoryConfirmed, false);
  assert.equal(
    Object.hasOwn(sourceEntry.provenance, 'checkoutInventoryConfirmed'),
    false,
  );
  assert.ok(sourceEntry.recovery);
  assert.ok(
    manifest.unresolvedSources.some(
      (entry) =>
        entry.source === sourceDirectory &&
        ['EACCES', 'EPERM'].includes(entry.error.code) &&
        entry.provenance.checkoutRoot === sourceBlockedCheckout,
    ),
  );

  assert.equal(await readFile(blockedStorePath, 'utf8'), blockedStoreText);
  assert.equal(await readFile(knownSourcePath, 'utf8'), knownSourceText);
  assert.equal(
    await readFile(knownDestination, 'utf8'),
    knownSourceText,
  );
  await assert.rejects(readFile(join(
    root.userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${sourceId}.json`,
  )));
});

test('invalid Issue Stores and YAML sidecars stay unresolved and are not copied', async () => {
  const root = await makeRoot();
  const { userRoot, sessionRoot } = root;
  const invalidStoreId = 'invalid-store';
  const invalidStorePath = join(sessionRoot, `${invalidStoreId}.json`);
  const invalidStoreText = `${JSON.stringify({
    conductorAgentId: invalidStoreId,
    issueUrl,
  })}\n`;
  const sidecarId = 'invalid-sidecars';
  const validStorePath = join(sessionRoot, `${sidecarId}.json`);
  const validStoreText = `${JSON.stringify(
    makeStore(sidecarId, issueUrl, '/old/clone'),
  )}\n`;
  const invalidQuestionsPath = join(
    sessionRoot,
    sidecarId,
    'open-questions.yaml',
  );
  const invalidQuestionsText =
    'version: 1\nsequence: 1\nopenQuestions:\n  - id: inq-1\n';
  const invalidStatePath = join(
    sessionRoot,
    sidecarId,
    'session-state.yaml',
  );
  const invalidStateText =
    'version: 2\ncurrent:\n  statusLine: ""\n  reportedAt: 1\nhistory: []\n';

  await mkdir(join(sessionRoot, sidecarId), { recursive: true });
  await writeFile(invalidStorePath, invalidStoreText, 'utf8');
  await writeFile(validStorePath, validStoreText, 'utf8');
  await writeFile(invalidQuestionsPath, invalidQuestionsText, 'utf8');
  await writeFile(invalidStatePath, invalidStateText, 'utf8');

  const result = runMigration(root, { apply: true });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const storeEntry = findEntry(manifest, invalidStorePath);
  const questionsEntry = findEntry(manifest, invalidQuestionsPath);
  const stateEntry = findEntry(manifest, invalidStatePath);

  assert.equal(storeEntry.disposition, 'unresolved');
  assert.match(storeEntry.reason, /version/u);
  assert.equal(questionsEntry.disposition, 'unresolved');
  assert.match(questionsEntry.reason, /openQuestions\[0\]\.question/u);
  assert.equal(stateEntry.disposition, 'unresolved');
  assert.match(stateEntry.reason, /statusLine/u);
  assert.ok(storeEntry.sourceSha256);
  assert.ok(questionsEntry.sourceSha256);
  assert.ok(stateEntry.sourceSha256);
  assert.equal(
    await readFile(invalidStorePath, 'utf8'),
    invalidStoreText,
  );
  assert.equal(
    await readFile(invalidQuestionsPath, 'utf8'),
    invalidQuestionsText,
  );
  assert.equal(await readFile(invalidStatePath, 'utf8'), invalidStateText);
  await assert.rejects(
    readFile(
      join(
        userRoot,
        'sessions',
        'github.com',
        'example',
        'repo',
        `${invalidStoreId}.json`,
      ),
    ),
  );
  await assert.rejects(
    readFile(
      join(
        userRoot,
        'sessions',
        'github.com',
        'example',
        'repo',
        sidecarId,
        'open-questions.yaml',
      ),
    ),
  );
  await assert.rejects(
    readFile(
      join(
        userRoot,
        'sessions',
        'github.com',
        'example',
        'repo',
        sidecarId,
        'session-state.yaml',
      ),
    ),
  );
});

test('conflicting Issue URLs for one conductor ID block related session and watch migration', async () => {
  const root = await makeRoot();
  const { userRoot, sessionRoot, operatorRoot } = root;
  const conductorAgentId = 'conflicting-issue-identity';
  const canonicalSlugRoot = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
  );
  const hashStorePath = join(
    sessionRoot,
    `${conductorAgentId}.json`,
  );
  const hashStoreText = `${JSON.stringify(
    makeStore(conductorAgentId, issueUrl, '/hash/checkout'),
  )}\n`;
  const canonicalStorePath = join(
    canonicalSlugRoot,
    `${conductorAgentId}.json`,
  );
  const canonicalIssueUrl = issueUrl.toLowerCase();
  const alternateIssueUrl = 'https://github.com/example/repo/issues/999';
  const canonicalStoreText = `${JSON.stringify(
    makeStore(conductorAgentId, alternateIssueUrl, '/other/checkout'),
  )}\n`;
  const sidecarPath = join(
    sessionRoot,
    conductorAgentId,
    'open-questions.yaml',
  );
  const sidecarText = 'version: 1\nsequence: 0\nopenQuestions: []\n';
  const toolCallsPath = join(
    sessionRoot,
    `${conductorAgentId}.tool-calls`,
  );
  const toolCallsText = '{"worker":"preserve"}\n';
  const transcriptPath = join(
    sessionRoot,
    'pi',
    'conflicting-issue.jsonl',
  );
  const transcriptText = `${JSON.stringify({
    type: 'session',
    id: conductorAgentId,
  })}\n{"type":"message"}\n`;
  const watchPath = join(operatorRoot, 'watch-state.json');
  const watchState = makeWatchState(conductorAgentId, issueUrl, 4);

  await mkdir(join(sessionRoot, conductorAgentId), { recursive: true });
  await mkdir(join(sessionRoot, 'pi'), { recursive: true });
  await mkdir(canonicalSlugRoot, { recursive: true });
  await mkdir(operatorRoot, { recursive: true });
  await writeFile(hashStorePath, hashStoreText, 'utf8');
  await writeFile(canonicalStorePath, canonicalStoreText, 'utf8');
  await writeFile(sidecarPath, sidecarText, 'utf8');
  await writeFile(toolCallsPath, toolCallsText, 'utf8');
  await writeFile(transcriptPath, transcriptText, 'utf8');
  await writeJson(watchPath, watchState);

  const result = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const storeEntry = findEntry(manifest, hashStorePath);
  const sidecarEntry = findEntry(manifest, sidecarPath);
  const toolCallsEntry = findEntry(manifest, toolCallsPath);
  const transcriptEntry = findEntry(manifest, transcriptPath);
  const watchEntry = findEntry(manifest, watchPath);

  for (const entry of [
    storeEntry,
    sidecarEntry,
    toolCallsEntry,
    transcriptEntry,
  ]) {
    assert.equal(entry.disposition, 'unresolved');
    assert.match(entry.reason, /conflicting Issue URLs/u);
    assert.ok(entry.recovery);
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/u);
    assert.ok(entry.evidence.issueUrls.includes(canonicalIssueUrl));
    assert.ok(entry.evidence.issueUrls.includes(alternateIssueUrl));
    assert.deepEqual(
      entry.evidence.sessionStoreSources,
      [canonicalStorePath, hashStorePath].sort(),
    );
  }
  assert.equal(storeEntry.destination, null);
  assert.equal(storeEntry.intendedDestination, canonicalStorePath);
  assert.equal(watchEntry.disposition, 'archived');
  assert.match(watchEntry.archiveReason, /conflicting Issue URLs/u);
  assert.deepEqual(watchEntry.evidence.issueUrls, [
    canonicalIssueUrl,
    alternateIssueUrl,
  ].sort());
  assert.deepEqual(
    watchEntry.evidence.sessionStoreSources,
    [canonicalStorePath, hashStorePath].sort(),
  );
  assert.equal(
    await readFile(canonicalStorePath, 'utf8'),
    canonicalStoreText,
  );
  assert.equal(await readFile(hashStorePath, 'utf8'), hashStoreText);
  assert.equal(await readFile(sidecarPath, 'utf8'), sidecarText);
  assert.equal(await readFile(toolCallsPath, 'utf8'), toolCallsText);
  assert.equal(await readFile(transcriptPath, 'utf8'), transcriptText);
  assert.equal(
    await fileExists(
      join(
        canonicalSlugRoot,
        conductorAgentId,
        'open-questions.yaml',
      ),
    ),
    false,
  );
  assert.equal(
    await fileExists(
      join(canonicalSlugRoot, `${conductorAgentId}.tool-calls`),
    ),
    false,
  );
  assert.equal(
    await fileExists(join(canonicalSlugRoot, 'pi', 'conflicting-issue.jsonl')),
    false,
  );
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
    'version: 2\ncurrent:\n  statusLine: Migrated\n  reportedAt: 10\nhistory: []\n';
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

test('slug-keyed watch sources dry-run, copy complete conductor bundles, and rerun without touching the source', async () => {
  const root = await makeRoot();
  const { userRoot } = root;
  const agentId = 'legacy-slug-watch';
  const sourcePath = join(
    userRoot,
    'operator-agent',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const storePath = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${agentId}.json`,
  );
  const sourceState = makeWatchState(agentId, issueUrl, 12);
  const sourceText = `${JSON.stringify(sourceState, null, 2)}\n`;
  await writeJson(storePath, makeStore(agentId, issueUrl, '/unrelated/clone'));
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, sourceText, 'utf8');

  const destination = join(
    userRoot,
    'operator-agents',
    'personal',
    'watch',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const dryRun = runMigration(root, { profile: 'personal' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  let manifest = await readManifest(root);
  let entry = findEntry(manifest, sourcePath);
  assert.equal(entry.kind, 'operator-watch-bundle');
  assert.equal(entry.disposition, 'planned-copy');
  assert.equal(entry.provenance.sourceType, 'user-slug-keyed');
  assert.equal(entry.provenance.legacySlug, 'github.com/example/repo');
  assert.equal(entry.evidence.legacySlug, 'github.com/example/repo');
  assert.equal(entry.evidence.operatorSelectedProfile, 'personal');
  assert.equal(
    entry.evidence.issueUrl,
    'https://github.com/example/repo/issues/607',
  );
  assert.ok(entry.sourceSha256);
  assert.equal(entry.destination, destination);
  assert.equal(await fileExists(destination), false);
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText);

  const apply = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(apply.status, 0, apply.stderr);
  manifest = await readManifest(root);
  entry = findEntry(manifest, sourcePath);
  assert.equal(entry.disposition, 'copied');
  const restored = JSON.parse(await readFile(destination, 'utf8'));
  assert.deepEqual(restored.watches[agentId], sourceState.watches[agentId]);
  assert.deepEqual(restored.cursors[agentId], sourceState.cursors[agentId]);
  assert.deepEqual(
    restored.messageListeners[agentId],
    sourceState.messageListeners[agentId],
  );
  assert.equal(
    restored.messageCursors[agentId],
    sourceState.messageCursors[agentId],
  );
  assert.deepEqual(restored.pendingReports, sourceState.pendingReports);
  assert.equal(entry.destinationSha256, entry.sourceBundleSha256);
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText);

  const rerun = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(rerun.status, 0, rerun.stderr);
  manifest = await readManifest(root);
  entry = findEntry(manifest, sourcePath);
  assert.equal(entry.disposition, 'no-op-identical');
  assert.equal(
    entry.sourceSha256,
    createHash('sha256').update(sourceText).digest('hex'),
  );
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText);
  assert.equal(
    await readFile(destination, 'utf8'),
    `${JSON.stringify(restored, null, 2)}\n`,
  );
});

test('slug-keyed watch inventory rejects an operator-agent symlink outside user root in both modes', async () => {
  const root = await makeRoot();
  const { userRoot } = root;
  const agentId = 'external-operator-root-watch';
  const operatorRoot = join(userRoot, 'operator-agent');
  const sourcePath = join(
    operatorRoot,
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const externalOperatorRoot = join(root.path, 'outside-operator-agent');
  const externalSourcePath = join(
    externalOperatorRoot,
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const sourceText = `${JSON.stringify(
    makeWatchState(agentId, issueUrl, 17),
    null,
    2,
  )}\n`;
  await mkdir(dirname(externalSourcePath), { recursive: true });
  await writeFile(externalSourcePath, sourceText, 'utf8');
  await writeJson(
    join(
      userRoot,
      'sessions',
      'github.com',
      'example',
      'repo',
      `${agentId}.json`,
    ),
    makeStore(agentId, issueUrl, '/unrelated/clone'),
  );
  await symlink(externalOperatorRoot, operatorRoot, 'dir');

  await assertSlugWatchSymlinkRejected(root, {
    sourcePath,
    externalSourcePath,
    linkPath: operatorRoot,
    expectedManifestSource: operatorRoot,
    sourceText,
    linkTarget: externalOperatorRoot,
    existingDestinationText: 'existing destination must remain unchanged\n',
    archiveSentinelText: 'existing archive must remain unchanged\n',
  });
});

test('slug-keyed watch inventory rejects an external watch-state symlink in both modes', async () => {
  const root = await makeRoot();
  const { userRoot } = root;
  const agentId = 'external-watch-state-file';
  const sourcePath = join(
    userRoot,
    'operator-agent',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const externalSourcePath = join(root.path, 'outside-watch-state.json');
  const sourceText = `${JSON.stringify(
    makeWatchState(agentId, issueUrl, 18),
    null,
    2,
  )}\n`;
  await writeFile(externalSourcePath, sourceText, 'utf8');
  await writeJson(
    join(
      userRoot,
      'sessions',
      'github.com',
      'example',
      'repo',
      `${agentId}.json`,
    ),
    makeStore(agentId, issueUrl, '/unrelated/clone'),
  );
  await mkdir(dirname(sourcePath), { recursive: true });
  await symlink(externalSourcePath, sourcePath, 'file');

  await assertSlugWatchSymlinkRejected(root, {
    sourcePath,
    externalSourcePath,
    linkPath: sourcePath,
    expectedManifestSource: sourcePath,
    sourceText,
    linkTarget: externalSourcePath,
  });
});

test('a slug-keyed source whose path disagrees with its SessionResumeStore is archived', async () => {
  const root = await makeRoot();
  const { userRoot } = root;
  const agentId = 'wrong-legacy-slug';
  const sourcePath = join(
    userRoot,
    'operator-agent',
    'github.com',
    'example',
    'other-repo',
    'watch-state.json',
  );
  const storePath = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${agentId}.json`,
  );
  await writeJson(storePath, makeStore(agentId, issueUrl, '/old'));
  await writeJson(sourcePath, makeWatchState(agentId, issueUrl, 2));

  const result = runMigration(root, {
    profile: 'personal',
    apply: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const entry = findEntry(manifest, sourcePath);
  assert.equal(entry.disposition, 'archived');
  assert.match(entry.archiveReason, /source path .* does not match/u);
  assert.equal(entry.provenance.legacySlug, 'github.com/example/other-repo');
  assert.ok(entry.sourceSha256);
  assert.ok(entry.destinationSha256);
  assert.ok(entry.recovery);
  assert.match(entry.destination, /operator-agents\/legacy\/watch\//u);
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
  assert.equal(await fileExists(sourcePath), true);
});

test('slug-keyed watch state is not assigned without an operator-selected profile', async () => {
  const root = await makeRoot();
  const { userRoot } = root;
  const agentId = 'profile-not-selected';
  const sourcePath = join(
    userRoot,
    'operator-agent',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const storePath = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${agentId}.json`,
  );
  const sourceState = makeWatchState(agentId, issueUrl, 3);
  const sourceText = `${JSON.stringify(sourceState, null, 2)}\n`;
  await writeJson(storePath, makeStore(agentId, issueUrl, '/old'));
  await writeJson(sourcePath, sourceState);

  const result = runMigration(root, { apply: true });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const entry = findEntry(manifest, sourcePath);
  assert.equal(entry.disposition, 'archived');
  assert.match(entry.archiveReason, /No operator-selected profile/u);
  assert.equal(entry.evidence.operatorSelectedProfile, undefined);
  assert.equal(
    entry.evidence.issueUrl,
    'https://github.com/example/repo/issues/607',
  );
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText);
  assert.equal(manifest.watchArchiveAcceptance.operatorAccepted, false);
  assert.equal(manifest.watchArchiveAcceptance.archiveEntries.length, 1);
  assert.ok(manifest.watchArchiveAcceptance.limitations.length >= 2);
  assert.equal(
    await fileExists(
      join(
        userRoot,
        'operator-agents',
        'watch',
        'github.com',
        'example',
        'repo',
        'watch-state.json',
      ),
    ),
    false,
  );
});

test('slug-keyed watch collisions archive intact and record explicit acceptance limitations', async () => {
  const root = await makeRoot();
  const { userRoot } = root;
  const agentId = 'slug-watch-collision';
  const sourcePath = join(
    userRoot,
    'operator-agent',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const storePath = join(
    userRoot,
    'sessions',
    'github.com',
    'example',
    'repo',
    `${agentId}.json`,
  );
  const destination = join(
    userRoot,
    'operator-agents',
    'personal',
    'watch',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const sourceState = makeWatchState(agentId, issueUrl, 5);
  const sourceText = `${JSON.stringify(sourceState, null, 2)}\n`;
  const destinationState = makeWatchState('existing-watch', issueUrl, 99);
  const destinationText = `${JSON.stringify(destinationState, null, 2)}\n`;
  await writeJson(storePath, makeStore(agentId, issueUrl, '/old'));
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, sourceText, 'utf8');
  await writeJson(destination, destinationState);

  const result = runMigration(root, {
    profile: 'personal',
    apply: true,
    acceptWatchArchiveLimitations: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const entry = findEntry(manifest, sourcePath);
  assert.equal(entry.disposition, 'archived');
  assert.match(entry.archiveReason, /cannot be overwritten/u);
  assert.ok(entry.sourceSha256);
  assert.ok(entry.sourceBundleSha256);
  assert.ok(entry.destinationSha256);
  assert.ok(entry.collisionReason);
  assert.ok(entry.recovery);
  assert.equal(await readFile(sourcePath, 'utf8'), sourceText);
  assert.equal(await readFile(destination, 'utf8'), destinationText);

  const acceptance = manifest.watchArchiveAcceptance;
  assert.equal(acceptance.operatorAccepted, true);
  assert.equal(
    acceptance.acceptanceEvidence,
    '--accept-watch-archive-limitations',
  );
  assert.ok(acceptance.acceptedAt);
  assert.equal(acceptance.archiveEntries.length, 1);
  assert.equal(acceptance.archiveEntries[0].source, sourcePath);
  assert.equal(acceptance.archiveEntries[0].sourceSha256, entry.sourceSha256);
  assert.match(
    acceptance.limitations.join('\n'),
    /silent baseline.*not replayed/u,
  );
  assert.match(
    acceptance.limitations.join('\n'),
    /question IDs, not question text.*at-least-once/u,
  );
});

test('unreadable slug-keyed watch sources stay unresolved and corrupt sources are archived intact', async () => {
  const root = await makeRoot();
  const sourcePath = join(
    root.userRoot,
    'operator-agent',
    'github.com',
    'example',
    'unreadable',
    'watch-state.json',
  );
  await writeJson(sourcePath, makeWatchState('unreadable-watch', issueUrl, 1));
  const corruptPath = join(
    root.userRoot,
    'operator-agent',
    'github.com',
    'example',
    'corrupt',
    'watch-state.json',
  );
  const corruptText = '{"version":1,"watches":';
  await mkdir(dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, corruptText, 'utf8');
  const preloadPath = join(root.path, 'deny-watch-state-read.mjs');
  await writeFile(
    preloadPath,
    [
      "import fs from 'node:fs/promises';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalReadFile = fs.readFile;',
      `const targetPath = ${JSON.stringify(sourcePath)};`,
      'fs.readFile = async (path, ...args) => {',
      '  if (String(path) === targetPath) {',
      "    const error = new Error('Injected unreadable watch-state source.');",
      "    Object.assign(error, { code: 'EACCES', errno: -13, syscall: 'open', path: targetPath });",
      '    throw error;',
      '  }',
      '  return originalReadFile.call(fs, path, ...args);',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = runMigration(root, { preloadPath, apply: true });
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readManifest(root);
  const unreadableEntry = findEntry(manifest, sourcePath);
  assert.equal(unreadableEntry.disposition, 'unresolved');
  assert.equal(unreadableEntry.sourceSha256, null);
  assert.equal(unreadableEntry.error.code, 'EACCES');
  assert.equal(unreadableEntry.error.syscall, 'open');
  assert.ok(unreadableEntry.reason);
  assert.ok(unreadableEntry.recovery);
  assert.equal(unreadableEntry.provenance.sourceType, 'user-slug-keyed');
  assert.ok(
    manifest.unresolvedSources.some(
      (source) =>
        source.source === sourcePath &&
        source.disposition === 'unresolved' &&
        source.sourceSha256 === null,
    ),
  );
  const corruptEntry = findEntry(manifest, corruptPath);
  assert.equal(corruptEntry.disposition, 'archived');
  assert.match(corruptEntry.archiveReason, /invalid JSON/u);
  assert.equal(
    corruptEntry.sourceSha256,
    createHash('sha256').update(corruptText).digest('hex'),
  );
  assert.equal(corruptEntry.destinationSha256, corruptEntry.sourceSha256);
  assert.equal(await readFile(corruptEntry.destination, 'utf8'), corruptText);
  assert.equal(await fileExists(sourcePath), true);
  assert.equal(await readFile(corruptPath, 'utf8'), corruptText);
});

test('user docs describe migration as explicit inventory and copy', async () => {
  const repositoryRoot = resolve(dirname(scriptPath), '..');
  const sessionLogging = await readFile(
    join(repositoryRoot, 'docs', 'session-logging.md'),
    'utf8',
  );
  const liveControl = await readFile(
    join(repositoryRoot, 'docs', 'live-open-question-control-api.md'),
    'utf8',
  );

  assert.match(
    sessionLogging,
    /user path-hash に残る Issue session data.*operator が指定した checkout/u,
  );
  assert.match(
    sessionLogging,
    /必要な場合に利用者が明示的な migration tool で調べる source/u,
  );
  assert.match(
    sessionLogging,
    /旧 slug-keyed watch.*symlink.*userRoot 外.*source 内容を読まず.*unresolved.*copy \/ archive を行いません/u,
  );
  assert.match(
    sessionLogging,
    /root が 0 件の場合.*`complete: false`/u,
  );
  assert.match(
    sessionLogging,
    /filesystem error が起きた場合.*`errno`.*`unresolvedSources`/u,
  );
  assert.match(
    sessionLogging,
    /`complete` だけで個々の root \/ source の確認済みとは判断できません/u,
  );
  assert.match(sessionLogging, /`operatorAssertedComplete` は/u);
  assert.match(sessionLogging, /`scanCompleted` は/u);
  assert.match(
    sessionLogging,
    /`provenance\.checkoutRootInventoryConfirmed` は、関連 root の `inventoryConfirmed` と同じ値/u,
  );
  assert.match(
    sessionLogging,
    /`unconfirmedRoots` は `inventoryConfirmed: false` の declared root だけを列挙し、global の `scanCompleted` \/ `complete` とは別/u,
  );
  assert.match(
    liveControl,
    /runtime fallback ではなく、残る old data を利用者が明示的に inventory \/ copy/u,
  );
  assert.match(
    liveControl,
    /旧 slug-keyed source では source path の slug も Store の Issue URL と一致/u,
  );
  assert.match(
    liveControl,
    /`--accept-watch-archive-limitations`.*operator acceptance/u,
  );
  assert.match(
    sessionLogging,
    /旧 slug-keyed `operator-agent\/github\.com\/<owner>\/<repo>\/watch-state\.json`/u,
  );
  assert.match(
    sessionLogging,
    /`watchArchiveAcceptance` に記録/u,
  );
  assert.match(
    sessionLogging,
    /silent baseline.*再通知されません/u,
  );
  assert.match(
    sessionLogging,
    /同じ質問文でも ID が違えば別の質問/u,
  );
  assert.ok(
    liveControl.includes(
      '通常の永続化先は `~/.ensemble/sessions/github.com/<owner>/<repo>/{conductorAgentId}/open-questions.yaml`',
    ),
  );
  assert.ok(
    liveControl.includes(
      'SessionResumeStore は `~/.ensemble/sessions/github.com/<owner>/<repo>/{conductorAgentId}.json`',
    ),
  );
  assert.ok(
    liveControl.includes(
      '`~/.ensemble/sessions/<repoKey>/` は migration source であり、runtime は読みません。',
    ),
  );
  assert.ok(
    !liveControl.includes(
      '永続化先は `~/.ensemble/sessions/<repoKey>/',
    ),
  );
  assert.ok(
    !liveControl.includes(
      '- `~/.ensemble/sessions/<repoKey>/` と session data directory',
    ),
  );

  for (const document of [sessionLogging, liveControl]) {
    assert.doesNotMatch(
      document,
      /新規 session の通常保存先は引き続き path-hash/u,
    );
    assert.doesNotMatch(
      document,
      /現在の `--resume` 検証は保存値と実行中の `repoRoot` の一致を要求/u,
    );
    assert.doesNotMatch(
      document,
      /operator-agent の session \/ watch state は従来どおり hash location/u,
    );
  }
});

test('persistence docs use canonical slug paths and identify legacy migration sources', async () => {
  const repositoryRoot = resolve(dirname(scriptPath), '..');
  const documentPaths = [
    'docs/settings.md',
    'docs/architecture.md',
    'docs/operator-input.md',
    'docs/cli/README.md',
    'docs/config.md',
  ];
  const documents = await Promise.all(
    documentPaths.map((path) =>
      readFile(join(repositoryRoot, path), 'utf8'),
    ),
  );

  for (const [index, document] of documents.entries()) {
    assert.ok(
      document.includes('~/.ensemble/sessions/github.com/<owner>/<repo>'),
      `${documentPaths[index]} must describe canonical slug storage`,
    );
    assert.doesNotMatch(
      document,
      /新規 session の通常保存先は引き続き path-hash/u,
      `${documentPaths[index]} must not describe path-hash as the current Issue-session destination`,
    );
    assert.doesNotMatch(
      document,
      /移行期間中は両方に同一内容を保存/u,
      `${documentPaths[index]} must not claim path-hash and slug dual-write`,
    );
  }

  // #697 moves new operator state to profile and canonical-slug paths. The
  // settings reference must describe that runtime destination.
  assert.match(
    documents[0],
    /operator-agent の新規 state は user 層に保存します。conversation record \/ Pi transcript は `operatorAgentId` ごと、watch state は profile と canonical repository slug ごとに分けます/u,
  );

  assert.match(
    documents[1],
    /Pi transcript は canonical slug のみから読み取り、legacy path-hash \/ project transcript は明示 migration の source です/u,
  );
  assert.doesNotMatch(
    documents[1],
    /Pi は `repoRoot` 基準の user 層 transcript を優先/u,
  );
  assert.match(
    documents[1],
    /path-hash \/ project-local legacy は通常読まず、自動 promotion もしません/u,
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
    acceptWatchArchiveLimitations = false,
    preloadPath,
  } = {},
) {
  root.manifestRun += 1;
  root.manifestPath = join(
    root.path,
    `migration-manifest-${root.manifestRun}.json`,
  );
  const args = [
    ...(preloadPath ? ['--import', preloadPath] : []),
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
  if (acceptWatchArchiveLimitations) {
    args.push('--accept-watch-archive-limitations');
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

async function assertSlugWatchSymlinkRejected(
  root,
  {
    sourcePath,
    externalSourcePath,
    linkPath,
    expectedManifestSource,
    sourceText,
    linkTarget,
    existingDestinationText,
    archiveSentinelText,
  },
) {
  const markerPath = join(root.path, 'external-watch-read-attempted');
  const preloadPath = join(root.path, 'guard-external-watch-read.mjs');
  await writeFile(
    preloadPath,
    [
      "import fs from 'node:fs';",
      "import fsp from 'node:fs/promises';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const watchedPaths = new Set(${JSON.stringify([
        sourcePath,
        externalSourcePath,
      ])});`,
      `const markerPath = ${JSON.stringify(markerPath)};`,
      'const rejectExternalRead = (path, operation) => {',
      '  if (!watchedPaths.has(String(path))) return;',
      '  fs.writeFileSync(markerPath, operation);',
      "  const error = new Error('Blocked read of an external watch source.');",
      "  Object.assign(error, { code: 'EACCES', errno: -13, syscall: operation, path: String(path) });",
      '  throw error;',
      '};',
      'const originalReadFile = fsp.readFile;',
      'fsp.readFile = async (path, ...args) => {',
      "  rejectExternalRead(path, 'readFile');",
      '  return originalReadFile.call(fsp, path, ...args);',
      '};',
      'const originalCreateReadStream = fs.createReadStream;',
      'fs.createReadStream = (path, ...args) => {',
      "  rejectExternalRead(path, 'createReadStream');",
      '  return originalCreateReadStream.call(fs, path, ...args);',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'),
    'utf8',
  );

  const destination = join(
    root.userRoot,
    'operator-agents',
    'personal',
    'watch',
    'github.com',
    'example',
    'repo',
    'watch-state.json',
  );
  const archiveDirectory = join(
    root.userRoot,
    'operator-agents',
    'legacy',
    'watch',
  );
  const archiveSentinelPath = join(archiveDirectory, 'sentinel.json');
  if (existingDestinationText !== undefined) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, existingDestinationText, 'utf8');
  }
  if (archiveSentinelText !== undefined) {
    await mkdir(archiveDirectory, { recursive: true });
    await writeFile(archiveSentinelPath, archiveSentinelText, 'utf8');
  }
  const sourceMetadataBefore = await pathMetadata(externalSourcePath);
  const linkMetadataBefore = await pathMetadata(linkPath);
  for (const apply of [false, true]) {
    const result = runMigration(root, {
      profile: 'personal',
      apply,
      preloadPath,
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = await readManifest(root);
    const entry = manifest.entries.find(
      (candidate) =>
        candidate.source === expectedManifestSource &&
        candidate.provenance.sourceType === 'user-slug-keyed' &&
        candidate.disposition === 'unresolved',
    );
    assert.ok(entry, 'manifest should identify the rejected slug-keyed path');
    assert.match(entry.reason, /symlink.*outside.*user root/iu);
    assert.match(entry.recovery, /symlink/iu);
    assert.equal(await fileExists(markerPath), false);
    if (existingDestinationText === undefined) {
      assert.equal(await fileExists(destination), false);
    } else {
      assert.equal(
        await readFile(destination, 'utf8'),
        existingDestinationText,
      );
    }
    if (archiveSentinelText === undefined) {
      assert.equal(await pathExists(archiveDirectory), false);
    } else {
      assert.deepEqual(await readdir(archiveDirectory), ['sentinel.json']);
      assert.equal(
        await readFile(archiveSentinelPath, 'utf8'),
        archiveSentinelText,
      );
    }
    assert.equal(await readFile(externalSourcePath, 'utf8'), sourceText);
    assert.equal(await readlink(linkPath), linkTarget);
    assert.deepEqual(
      await pathMetadata(externalSourcePath),
      sourceMetadataBefore,
    );
    assert.deepEqual(await pathMetadata(linkPath), linkMetadataBefore);
  }
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

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function pathMetadata(path) {
  const info = await lstat(path);
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}
