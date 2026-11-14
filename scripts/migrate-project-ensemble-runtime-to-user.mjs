#!/usr/bin/env node
/**
 * Inventory and copy legacy Issue-session and operator watch data to the
 * canonical user-scoped locations described by ADR 0061.
 *
 * Dry-run is the default. The manifest is written on every run; copied source
 * files are never removed or renamed, and existing data destinations are
 * never overwritten.
 *
 *   node scripts/migrate-project-ensemble-runtime-to-user.mjs \
 *     --checkout-root /path/to/checkout \
 *     --checkout-roots-complete \
 *     --profile personal \
 *     --dry-run
 *   node scripts/migrate-project-ensemble-runtime-to-user.mjs \
 *     --checkout-root /path/to/checkout \
 *     --checkout-roots-complete \
 *     --profile personal \
 *     --apply
 *
 * Repeat --checkout-root for every checkout the operator has inventoried.
 * If watch state should be archived without assigning it to a profile, omit
 * --profile. ENSEMBLE_USER_ROOT overrides ~/.ensemble.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

const USER_ROOT_ENV = 'ENSEMBLE_USER_ROOT';
const HASH_DIRECTORY_RE = /^[a-f0-9]{64}$/u;
const ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/iu;
const SESSION_SIDECARS = new Set([
  'open-questions.yaml',
  'session-state.yaml',
]);
const WATCH_STATE_VERSION = 1;

function usage() {
  process.stdout.write(
    [
      'Usage: migrate-project-ensemble-runtime-to-user.mjs [options]',
      '',
      'Options:',
      '  --checkout-root <path>       Checkout to inventory (repeatable)',
      '  --checkout-roots-complete    Assert that all relevant checkouts are listed',
      '  --profile <name>             Operator-selected profile for eligible watch bundles',
      '  --user-root <path>           User data root (default: ENSEMBLE_USER_ROOT or ~/.ensemble)',
      '  --manifest <path>            Manifest output path',
      '  --dry-run                    Inventory only (default)',
      '  --apply                      Copy eligible data and write the manifest',
      '  --help                       Show this help',
      '',
      'The legacy --repo-root <path> option is accepted as an alias for',
      '--checkout-root. It does not assert that the checkout inventory is complete.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    checkoutRoots: [],
    checkoutRootsComplete: false,
    profile: undefined,
    userRoot:
      process.env[USER_ROOT_ENV] || join(homedir(), '.ensemble'),
    manifest: undefined,
    help: false,
  };
  let selectedMode;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '--apply') {
      const mode = arg === '--apply' ? 'apply' : 'dry-run';
      if (selectedMode && selectedMode !== mode) {
        throw new Error('--dry-run and --apply cannot be used together.');
      }
      selectedMode = mode;
      options.mode = mode;
      continue;
    }
    if (
      arg === '--checkout-root' ||
      arg === '--repo-root' ||
      arg === '--profile' ||
      arg === '--user-root' ||
      arg === '--manifest'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      if (arg === '--checkout-root' || arg === '--repo-root') {
        options.checkoutRoots.push(value);
      } else if (arg === '--profile') {
        options.profile = value;
      } else if (arg === '--user-root') {
        options.userRoot = value;
      } else {
        options.manifest = value;
      }
      continue;
    }
    if (arg === '--checkout-roots-complete') {
      options.checkoutRootsComplete = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  options.userRoot = normalize(resolve(options.userRoot));
  options.checkoutRoots = options.checkoutRoots.map((root) =>
    normalize(resolve(root)),
  );
  options.manifest = normalize(
    resolve(
      options.manifest ??
        join(
          options.userRoot,
          'migration',
          `issue-session-migration-${Date.now()}-${randomUUID()}.json`,
        ),
    ),
  );
  if (options.profile !== undefined && !isSafePathSegment(options.profile)) {
    throw new Error(
      '--profile must be one safe path segment (letters, numbers, ".", "_" or "-"; not "." or "..").',
    );
  }
  return options;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafePathSegment(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9_.-]+$/u.test(value) &&
    !value.includes('..' + sep)
  );
}

function parseIssueUrl(value) {
  if (typeof value !== 'string') return undefined;
  const match = ISSUE_URL_RE.exec(value.trim());
  if (!match) return undefined;
  const owner = match[1].toLowerCase();
  const repository = match[2].replace(/\.git$/iu, '').toLowerCase();
  const number = Number(match[3]);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    [owner, repository].some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        !/^[a-z0-9_.-]+$/u.test(segment),
    )
  ) {
    return undefined;
  }
  return {
    owner,
    repository,
    number,
    slug: join('github.com', owner, repository),
    canonicalUrl: `https://github.com/${owner}/${repository}/issues/${number}`,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function repoKeyForRoot(root) {
  return sha256(Buffer.from(normalize(resolve(root)), 'utf8'));
}

function storeKey(repoKey, conductorAgentId) {
  return `${repoKey}\0${conductorAgentId}`;
}

function isWithin(directory, path) {
  const relativePath = relative(directory, path);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function emptyWatchState() {
  return {
    version: WATCH_STATE_VERSION,
    watches: {},
    cursors: {},
    messageListeners: {},
    messageCursors: {},
    pendingReports: [],
  };
}

function serializeWatchState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function extractWatchBundle(state, conductorAgentId) {
  const bundle = emptyWatchState();
  for (const key of [
    'watches',
    'cursors',
    'messageListeners',
    'messageCursors',
  ]) {
    if (Object.hasOwn(state[key], conductorAgentId)) {
      bundle[key][conductorAgentId] = state[key][conductorAgentId];
    }
  }
  bundle.pendingReports = state.pendingReports.filter(
    (report) => report.conductorAgentId === conductorAgentId,
  );
  return bundle;
}

function normalizeWatchState(value) {
  if (
    !isRecord(value) ||
    value.version !== WATCH_STATE_VERSION ||
    !isRecord(value.watches) ||
    !isRecord(value.cursors) ||
    !Array.isArray(value.pendingReports) ||
    (value.messageListeners !== undefined &&
      !isRecord(value.messageListeners)) ||
    (value.messageCursors !== undefined && !isRecord(value.messageCursors))
  ) {
    return undefined;
  }
  const state = {
    version: WATCH_STATE_VERSION,
    watches: value.watches,
    cursors: value.cursors,
    messageListeners: value.messageListeners ?? {},
    messageCursors: value.messageCursors ?? {},
    pendingReports: value.pendingReports,
  };
  const isNonNegativeInteger = (input) =>
    Number.isSafeInteger(input) && input >= 0;
  const isStringMap = (input) =>
    isRecord(input) &&
    Object.values(input).every((item) => typeof item === 'string');
  const ids = new Set([
    ...Object.keys(state.watches),
    ...Object.keys(state.cursors),
    ...Object.keys(state.messageListeners),
    ...Object.keys(state.messageCursors),
  ]);
  for (const [id, watch] of Object.entries(state.watches)) {
    if (
      !isSafePathSegment(id) ||
      !isRecord(watch) ||
      watch.conductorAgentId !== id ||
      !Number.isInteger(watch.pollIntervalMs) ||
      watch.pollIntervalMs < 250 ||
      watch.pollIntervalMs > 60_000 ||
      !Number.isInteger(watch.debounceMs) ||
      watch.debounceMs < 0 ||
      watch.debounceMs > 10_000
    ) {
      return undefined;
    }
  }
  for (const [id, cursor] of Object.entries(state.cursors)) {
    if (
      !isSafePathSegment(id) ||
      !isRecord(cursor) ||
      !isNonNegativeInteger(cursor.sequence) ||
      !isStringMap(cursor.questionFingerprints) ||
      !isStringMap(cursor.statusFingerprints) ||
      (cursor.questionSnapshots !== undefined &&
        (!isRecord(cursor.questionSnapshots) ||
          !Object.values(cursor.questionSnapshots).every(
            (snapshot) =>
              isRecord(snapshot) &&
              typeof snapshot.question === 'string' &&
              (snapshot.status === 'open' || snapshot.status === 'answered') &&
              typeof snapshot.askedAt === 'number' &&
              Number.isFinite(snapshot.askedAt),
          )))
    ) {
      return undefined;
    }
  }
  for (const [id, listener] of Object.entries(state.messageListeners)) {
    if (
      !isSafePathSegment(id) ||
      !isRecord(listener) ||
      listener.conductorAgentId !== id ||
      !Number.isInteger(listener.messageDebounceMs) ||
      listener.messageDebounceMs < 0 ||
      listener.messageDebounceMs > 120_000
    ) {
      return undefined;
    }
  }
  for (const [id, cursor] of Object.entries(state.messageCursors)) {
    if (!isSafePathSegment(id) || !isNonNegativeInteger(cursor)) {
      return undefined;
    }
  }
  const reportIds = new Set();
  for (const report of state.pendingReports) {
    if (
      !isRecord(report) ||
      typeof report.conductorAgentId !== 'string' ||
      !isSafePathSegment(report.conductorAgentId) ||
      typeof report.reportId !== 'string' ||
      report.reportId.trim() === '' ||
      reportIds.has(report.reportId) ||
      typeof report.issueUrl !== 'string' ||
      typeof report.text !== 'string' ||
      !Number.isInteger(report.debounceMs) ||
      report.debounceMs < 0 ||
      ![
        'session_state',
        'open_question',
        'conductor_message',
      ].includes(report.reportType) ||
      report.debounceMs >
        (report.reportType === 'conductor_message' ? 120_000 : 10_000) ||
      (report.reportType === 'conductor_message' &&
        !isNonNegativeInteger(report.sendCount)) ||
      (report.oversizedSendCounts !== undefined &&
        (report.reportType !== 'conductor_message' ||
          !Array.isArray(report.oversizedSendCounts) ||
          report.oversizedSendCounts.length === 0 ||
          !report.oversizedSendCounts.every(isNonNegativeInteger)))
    ) {
      return undefined;
    }
    reportIds.add(report.reportId);
    ids.add(report.conductorAgentId);
  }
  for (const id of ids) {
    if (!isSafePathSegment(id)) return undefined;
    const watch = state.watches[id];
    if (watch !== undefined && watch.conductorAgentId !== id) return undefined;
    const listener = state.messageListeners[id];
    if (
      listener !== undefined &&
      (!isRecord(listener) || listener.conductorAgentId !== id)
    ) {
      return undefined;
    }
  }
  return { state, ids: [...ids].sort() };
}

function addManifestEntry(manifest, entry) {
  manifest.entries.push({
    source: entry.source ?? null,
    destination: entry.destination ?? null,
    kind: entry.kind,
    disposition: entry.disposition,
    reason: entry.reason ?? null,
    sourceSha256: entry.sourceSha256 ?? null,
    sourceBundleSha256: entry.sourceBundleSha256 ?? null,
    destinationSha256: entry.destinationSha256 ?? null,
    destinationBundleSha256: entry.destinationBundleSha256 ?? null,
    collisionReason: entry.collisionReason ?? null,
    archiveReason: entry.archiveReason ?? null,
    recovery: entry.recovery ?? null,
    provenance: entry.provenance ?? {},
    evidence: entry.evidence ?? {},
    ...(entry.intendedDestination
      ? { intendedDestination: entry.intendedDestination }
      : {}),
  });
  return manifest.entries.at(-1);
}

function unresolvedEntry(manifest, source, kind, reason, provenance = {}) {
  return addManifestEntry(manifest, {
    source,
    kind,
    disposition: 'unresolved',
    reason,
    recovery:
      'Keep the source unchanged. Resolve its provenance or restore a valid Issue session Store, then rerun the inventory.',
    provenance,
  });
}

async function pathKind(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

async function listDirectory(path, manifest, kind, provenance = {}) {
  const type = await pathKind(path);
  if (type === 'missing') return [];
  if (type !== 'directory') {
    unresolvedEntry(
      manifest,
      path,
      kind,
      type === 'symlink'
        ? 'Source directory is a symlink and was not followed.'
        : 'Expected a regular directory.',
      provenance,
    );
    return [];
  }
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    unresolvedEntry(
      manifest,
      path,
      kind,
      `Could not enumerate source directory: ${error.message}`,
      provenance,
    );
    return [];
  }
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function readSource(
  path,
  manifest,
  kind,
  provenance = {},
  { loadBytes = true } = {},
) {
  const type = await pathKind(path);
  if (type !== 'file') {
    unresolvedEntry(
      manifest,
      path,
      kind,
      type === 'symlink'
        ? 'Source is a symlink and was not followed.'
        : 'Source is not a regular file.',
      provenance,
    );
    return undefined;
  }
  try {
    if (!loadBytes) {
      return { sha: await hashFile(path) };
    }
    const bytes = await readFile(path);
    return { bytes, sha: sha256(bytes) };
  } catch (error) {
    unresolvedEntry(
      manifest,
      path,
      kind,
      `Could not read source file: ${error.message}`,
      provenance,
    );
    return undefined;
  }
}

function addStoreCandidate(
  storeIndex,
  repoKey,
  conductorAgentId,
  record,
) {
  const key = storeKey(repoKey, conductorAgentId);
  const candidates = storeIndex.get(key) ?? [];
  candidates.push(record);
  storeIndex.set(key, candidates);
  if (repoKey !== '*') {
    const globalKey = storeKey('*', conductorAgentId);
    const globalCandidates = storeIndex.get(globalKey) ?? [];
    globalCandidates.push(record);
    storeIndex.set(globalKey, globalCandidates);
  }
}

function storeEvidence(storeIndex, repoKey, conductorAgentId) {
  const scopedCandidates =
    storeIndex.get(storeKey(repoKey, conductorAgentId)) ?? [];
  const candidates =
    scopedCandidates.length > 0
      ? scopedCandidates
      : storeIndex.get(storeKey('*', conductorAgentId)) ?? [];
  const valid = candidates.filter((candidate) => candidate.issue);
  const hasInvalid = candidates.some((candidate) => !candidate.issue);
  const slugs = new Set(valid.map((candidate) => candidate.issue.slug));
  const issueUrls = new Set(valid.map((candidate) => candidate.issue.canonicalUrl));
  return {
    candidates,
    valid,
    hasInvalid,
    slugs,
    issueUrls,
    slug: slugs.size === 1 ? [...slugs][0] : undefined,
    issueUrl: issueUrls.size === 1 ? [...issueUrls][0] : undefined,
    issue: valid.length > 0 && slugs.size === 1 ? valid[0].issue : undefined,
    storeSources: valid.map((candidate) => candidate.source).sort(),
  };
}

function makeProvenance(sourceType, repoKey, checkoutRoot) {
  return {
    sourceType,
    ...(repoKey ? { repoKey } : {}),
    ...(checkoutRoot ? { checkoutRoot } : {}),
  };
}

async function legacyPiOperatorSessionIds({
  userRoot,
  repoKey,
  projectRoot,
}) {
  const paths = [
    join(userRoot, 'operator-agent', repoKey, 'session.json'),
    ...(projectRoot
      ? [join(projectRoot, 'operator-agent', 'session.json')]
      : []),
  ];
  const ids = new Set();
  for (const path of paths) {
    try {
      if ((await pathKind(path)) !== 'file') continue;
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (
        isRecord(value) &&
        value.backend === 'pi' &&
        isSafePathSegment(value.agentId)
      ) {
        ids.add(value.agentId);
      }
    } catch {
      // The old conversation record is deliberately outside migration
      // inventory; an unreadable record cannot prove transcript ownership.
    }
  }
  return ids;
}

async function scanSessionDirectory({
  directory,
  repoKey,
  sourceType,
  checkoutRoot,
  userRoot,
  excludedPiTranscriptIds = new Set(),
  manifest,
  storeIndex,
  copyCandidates,
  linkedTasks,
}) {
  const provenance = makeProvenance(sourceType, repoKey, checkoutRoot);
  const entries = await listDirectory(
    directory,
    manifest,
    'issue-session-source-directory',
    provenance,
  );
  const sidecarDirectories = [];
  const toolCallFiles = [];
  const piDirectories = [];

  for (const entry of entries) {
    const source = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      unresolvedEntry(
        manifest,
        source,
        'issue-session-source',
        'Symlink source was not followed.',
        provenance,
      );
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith('.json')) {
        const conductorAgentId = entry.name.slice(0, -'.json'.length);
        const sourceInfo = await readSource(
          source,
          manifest,
          'session-resume-store',
          provenance,
        );
        if (!sourceInfo) continue;
        let value;
        try {
          value = JSON.parse(sourceInfo.bytes.toString('utf8'));
        } catch {
          addStoreCandidate(storeIndex, repoKey, conductorAgentId, {
            issue: undefined,
            source,
          });
          addManifestEntry(manifest, {
            source,
            kind: 'session-resume-store',
            disposition: 'unresolved',
            reason: 'SessionResumeStore is not valid JSON.',
            sourceSha256: sourceInfo.sha,
            recovery:
              'Preserve the source and repair or manually recover the Store before migration.',
            provenance,
          });
          continue;
        }
        const issue =
          isRecord(value) &&
          value.conductorAgentId === conductorAgentId &&
          isSafePathSegment(conductorAgentId)
            ? parseIssueUrl(value.issueUrl)
            : undefined;
        addStoreCandidate(storeIndex, repoKey, conductorAgentId, {
          issue,
          source,
          sourceSha256: sourceInfo.sha,
        });
        if (!issue) {
          addManifestEntry(manifest, {
            source,
            kind: 'session-resume-store',
            disposition: 'unresolved',
            reason:
              'A matching conductorAgentId and valid GitHub Issue URL are required to prove the destination slug.',
            sourceSha256: sourceInfo.sha,
            recovery:
              'Keep the source unchanged. Supply a valid Store whose issueUrl identifies one canonical GitHub repository, then rerun.',
            provenance,
            evidence: {
              conductorAgentId,
              issueUrl:
                isRecord(value) && typeof value.issueUrl === 'string'
                  ? value.issueUrl
                  : null,
            },
          });
          continue;
        }
        copyCandidates.push({
          source,
          sourceSha: sourceInfo.sha,
          destination: join(
            userRoot,
            'sessions',
            issue.slug,
            `${conductorAgentId}.json`,
          ),
          kind: 'session-resume-store',
          provenance,
          evidence: {
            conductorAgentId,
            issueUrl: issue.canonicalUrl,
            canonicalSlug: issue.slug,
          },
          manifestEntry: addManifestEntry(manifest, {
            source,
            destination: join(
              userRoot,
              'sessions',
              issue.slug,
              `${conductorAgentId}.json`,
            ),
            kind: 'session-resume-store',
            disposition: 'pending',
            sourceSha256: sourceInfo.sha,
            recovery:
              'If the destination conflicts, retain both files and inspect their Store contents before choosing a recovery copy.',
            provenance,
            evidence: {
              conductorAgentId,
              issueUrl: issue.canonicalUrl,
              canonicalSlug: issue.slug,
            },
          }),
        });
      } else if (entry.name.endsWith('.tool-calls')) {
        toolCallFiles.push({ source, conductorAgentId: entry.name.slice(0, -'.tool-calls'.length) });
      } else {
        unresolvedEntry(
          manifest,
          source,
          'issue-session-source',
          'Unexpected file in a legacy session directory; it was not copied.',
          provenance,
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === 'pi') {
        piDirectories.push(source);
      } else if (isSafePathSegment(entry.name)) {
        sidecarDirectories.push({ source, conductorAgentId: entry.name });
      } else {
        unresolvedEntry(
          manifest,
          source,
          'issue-session-source',
          'Unexpected directory name in a legacy session directory.',
          provenance,
        );
      }
      continue;
    }
    unresolvedEntry(
      manifest,
      source,
      'issue-session-source',
      'Unsupported filesystem entry in a legacy session directory.',
      provenance,
    );
  }

  linkedTasks.push({
    repoKey,
    userRoot,
    provenance,
    toolCallFiles,
    sidecarDirectories,
    piDirectories,
    excludedPiTranscriptIds,
  });
}

async function processLinkedSessionData({
  task,
  manifest,
  storeIndex,
  copyCandidates,
}) {
  const {
    repoKey,
    userRoot,
    provenance,
    toolCallFiles,
    sidecarDirectories,
    piDirectories,
    excludedPiTranscriptIds,
  } = task;
  for (const { source, conductorAgentId } of toolCallFiles) {
    const evidence = storeEvidence(storeIndex, repoKey, conductorAgentId);
    if (evidence.hasInvalid || !evidence.slug) {
      unresolvedEntry(
        manifest,
        source,
        'tool-call-history',
        evidence.candidates.length === 0
          ? 'No matching SessionResumeStore proves the destination slug.'
          : 'Matching Stores do not prove one unambiguous destination slug.',
        { ...provenance, conductorAgentId },
      );
      continue;
    }
    const sourceInfo = await readSource(
      source,
      manifest,
      'tool-call-history',
      provenance,
      { loadBytes: false },
    );
    if (!sourceInfo) continue;
    const destination = join(
      userRoot,
      'sessions',
      evidence.slug,
      `${conductorAgentId}.tool-calls`,
    );
    copyCandidates.push({
      source,
      sourceSha: sourceInfo.sha,
      destination,
      kind: 'tool-call-history',
      provenance,
      evidence: {
        conductorAgentId,
        canonicalSlug: evidence.slug,
        issueUrls: [...evidence.issueUrls].sort(),
        sessionStoreSources: evidence.storeSources,
      },
      manifestEntry: addManifestEntry(manifest, {
        source,
        destination,
        kind: 'tool-call-history',
        disposition: 'pending',
        sourceSha256: sourceInfo.sha,
        recovery:
          'If the destination conflicts, retain both files and compare their checksums and session identity.',
        provenance,
        evidence: {
          conductorAgentId,
          canonicalSlug: evidence.slug,
          issueUrls: [...evidence.issueUrls].sort(),
          sessionStoreSources: evidence.storeSources,
        },
      }),
    });
  }

  for (const { source, conductorAgentId } of sidecarDirectories) {
    const sidecarEntries = await listDirectory(
      source,
      manifest,
      'issue-session-sidecar-directory',
      { ...provenance, conductorAgentId },
    );
    for (const sidecar of sidecarEntries) {
      const sidecarPath = join(source, sidecar.name);
      if (sidecar.isSymbolicLink()) {
        unresolvedEntry(
          manifest,
          sidecarPath,
          'issue-session-sidecar',
          'Symlink source was not followed.',
          { ...provenance, conductorAgentId },
        );
        continue;
      }
      if (!sidecar.isFile() || !SESSION_SIDECARS.has(sidecar.name)) {
        unresolvedEntry(
          manifest,
          sidecarPath,
          'issue-session-sidecar',
          'Unexpected entry in a legacy session sidecar directory.',
          { ...provenance, conductorAgentId },
        );
        continue;
      }
      const evidence = storeEvidence(storeIndex, repoKey, conductorAgentId);
      if (evidence.hasInvalid || !evidence.slug) {
        unresolvedEntry(
          manifest,
          sidecarPath,
          'issue-session-sidecar',
          evidence.candidates.length === 0
            ? 'No matching SessionResumeStore proves the destination slug.'
            : 'Matching Stores do not prove one unambiguous destination slug.',
          { ...provenance, conductorAgentId },
        );
        continue;
      }
      const sourceInfo = await readSource(
        sidecarPath,
        manifest,
        'issue-session-sidecar',
        provenance,
      );
      if (!sourceInfo) continue;
      const destination = join(
        userRoot,
        'sessions',
        evidence.slug,
        conductorAgentId,
        sidecar.name,
      );
      copyCandidates.push({
        source: sidecarPath,
        sourceSha: sourceInfo.sha,
        destination,
        kind: sidecar.name,
        provenance,
        evidence: {
          conductorAgentId,
          canonicalSlug: evidence.slug,
          issueUrls: [...evidence.issueUrls].sort(),
          sessionStoreSources: evidence.storeSources,
        },
        manifestEntry: addManifestEntry(manifest, {
          source: sidecarPath,
          destination,
          kind: sidecar.name,
          disposition: 'pending',
          sourceSha256: sourceInfo.sha,
          recovery:
            'If the destination conflicts, keep both versions and compare the question or status history before recovery.',
          provenance,
          evidence: {
            conductorAgentId,
            canonicalSlug: evidence.slug,
            issueUrls: [...evidence.issueUrls].sort(),
            sessionStoreSources: evidence.storeSources,
          },
        }),
      });
    }
  }

  for (const piDirectory of piDirectories) {
    await scanPiTranscriptDirectory({
      directory: piDirectory,
      repoKey,
      userRoot,
      manifest,
      storeIndex,
      copyCandidates,
      provenance,
      excludedPiTranscriptIds,
    });
  }
}

async function scanPiTranscriptDirectory({
  directory,
  repoKey,
  userRoot,
  manifest,
  storeIndex,
  copyCandidates,
  provenance,
  excludedPiTranscriptIds = new Set(),
}) {
  const transcriptEntries = await listDirectory(
    directory,
    manifest,
    'pi-transcript-directory',
    provenance,
  );
  for (const transcript of transcriptEntries) {
    const source = join(directory, transcript.name);
    if (transcript.isSymbolicLink()) {
      unresolvedEntry(
        manifest,
        source,
        'issue-pi-transcript-candidate',
        'Symlink source was not followed.',
        provenance,
      );
      continue;
    }
    if (!transcript.isFile()) {
      unresolvedEntry(
        manifest,
        source,
        'issue-pi-transcript-candidate',
        'Unsupported filesystem entry in the Pi session directory.',
        provenance,
      );
      continue;
    }
    const sourceInfo = await readSource(
      source,
      manifest,
      'issue-pi-transcript-candidate',
      provenance,
      { loadBytes: false },
    );
    if (!sourceInfo) continue;
    const transcriptId = await readPiSessionIdFromFile(source);
    if (transcriptId && excludedPiTranscriptIds.has(transcriptId)) {
      const possibleIssueStore = storeEvidence(
        storeIndex,
        repoKey,
        transcriptId,
      );
      if (possibleIssueStore.candidates.length === 0) {
        continue;
      }
      unresolvedEntry(
        manifest,
        source,
        'issue-pi-transcript-candidate',
        'Transcript id matches a legacy Pi operator conversation and a SessionResumeStore; ownership is ambiguous.',
        { ...provenance, conductorAgentId: transcriptId },
      );
      const unresolved = manifest.entries.at(-1);
      unresolved.sourceSha256 = sourceInfo.sha;
      unresolved.recovery =
        'Keep the shared transcript in place. Resolve whether it is an Issue session; do not copy or archive it as an operator conversation.';
      continue;
    }
    const evidence = transcriptId
      ? storeEvidence(storeIndex, repoKey, transcriptId)
      : undefined;
    if (
      !transcriptId ||
      !evidence ||
      evidence.hasInvalid ||
      !evidence.slug
    ) {
      unresolvedEntry(
        manifest,
        source,
        'issue-pi-transcript-candidate',
        !transcriptId
          ? 'Pi transcript has no readable session id; its Issue-session ownership is unresolved.'
          : evidence?.candidates.length === 0
            ? 'No matching SessionResumeStore proves this transcript belongs to an Issue session.'
            : 'Matching Stores do not prove one unambiguous destination slug.',
        {
          ...provenance,
          ...(transcriptId ? { conductorAgentId: transcriptId } : {}),
        },
      );
      const unresolved = manifest.entries.at(-1);
      unresolved.sourceSha256 = sourceInfo.sha;
      unresolved.recovery =
        'Keep this shared transcript in place. Resolve whether it belongs to an Issue session; do not discard or archive it as an operator conversation.';
      continue;
    }
    const destination = join(
      userRoot,
      'sessions',
      evidence.slug,
      'pi',
      basename(source),
    );
    copyCandidates.push({
      source,
      sourceSha: sourceInfo.sha,
      destination,
      kind: 'issue-pi-transcript',
      provenance,
      evidence: {
        conductorAgentId: transcriptId,
        canonicalSlug: evidence.slug,
        issueUrls: [...evidence.issueUrls].sort(),
        sessionStoreSources: evidence.storeSources,
      },
      manifestEntry: addManifestEntry(manifest, {
        source,
        destination,
        kind: 'issue-pi-transcript',
        disposition: 'pending',
        sourceSha256: sourceInfo.sha,
        recovery:
          'If the destination conflicts, preserve the source and compare Pi session id and transcript checksums.',
        provenance,
        evidence: {
          conductorAgentId: transcriptId,
          canonicalSlug: evidence.slug,
          issueUrls: [...evidence.issueUrls].sort(),
          sessionStoreSources: evidence.storeSources,
        },
      }),
    });
  }
}

async function readPiSessionIdFromFile(path) {
  let file;
  try {
    file = await open(path, 'r');
    const chunks = [];
    let totalBytes = 0;
    let position = 0;
    let firstLine;
    while (totalBytes <= 65_536) {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        totalBytes += newline;
        firstLine = Buffer.concat(chunks).toString('utf8');
        break;
      }
      chunks.push(chunk);
      totalBytes += bytesRead;
    }
    if (firstLine === undefined && totalBytes <= 65_536) {
      firstLine = Buffer.concat(chunks).toString('utf8');
    }
    if (!firstLine || totalBytes > 65_536) return undefined;
    const first = JSON.parse(firstLine.replace(/\r$/u, ''));
    return isRecord(first) &&
      first.type === 'session' &&
      isSafePathSegment(first.id)
      ? first.id
      : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

async function scanHashSessionRoots({
  userRoot,
  manifest,
  storeIndex,
  copyCandidates,
  linkedTasks,
}) {
  const sessionsRoot = join(userRoot, 'sessions');
  const entries = await listDirectory(
    sessionsRoot,
    manifest,
    'user-session-root',
  );
  for (const entry of entries) {
    if (!HASH_DIRECTORY_RE.test(entry.name)) continue;
    const directory = join(sessionsRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      unresolvedEntry(
        manifest,
        directory,
        'path-hash-session-root',
        'Path-hash source root is not a regular directory.',
        { sourceType: 'user-path-hash', repoKey: entry.name },
      );
      continue;
    }
    const excludedPiTranscriptIds = await legacyPiOperatorSessionIds({
      userRoot,
      repoKey: entry.name,
    });
    await scanSessionDirectory({
      directory,
      repoKey: entry.name,
      sourceType: 'user-path-hash',
      userRoot,
      excludedPiTranscriptIds,
      manifest,
      storeIndex,
      copyCandidates,
      linkedTasks,
    });
  }
}

async function scanCheckoutRoots({
  checkoutRoots,
  checkoutRootsComplete,
  userRoot,
  manifest,
  storeIndex,
  copyCandidates,
  linkedTasks,
}) {
  const seenRoots = new Set();
  for (const declaredRoot of checkoutRoots) {
    const rootRecord = {
      path: declaredRoot,
      disposition: 'unresolved',
      reason: null,
      repoKey: null,
    };
    manifest.checkoutInventory.declaredRoots.push(rootRecord);

    const type = await pathKind(declaredRoot);
    if (type !== 'directory') {
      rootRecord.reason =
        type === 'symlink'
          ? 'Checkout root is a symlink; it was not followed.'
          : 'Checkout root does not exist as a directory.';
      manifest.checkoutInventory.unresolvedRoots.push(declaredRoot);
      continue;
    }
    const marker = await pathKind(join(declaredRoot, '.git'));
    if (marker !== 'directory' && marker !== 'file') {
      rootRecord.reason =
        'Checkout root has no regular .git directory or worktree .git file.';
      manifest.checkoutInventory.unresolvedRoots.push(declaredRoot);
      continue;
    }
    const rootIdentity = normalize(resolve(declaredRoot));
    if (seenRoots.has(rootIdentity)) {
      rootRecord.disposition = 'duplicate';
      rootRecord.reason = 'The same checkout root was already scanned.';
      rootRecord.repoKey = repoKeyForRoot(declaredRoot);
      continue;
    }
    seenRoots.add(rootIdentity);
    const repoKey = repoKeyForRoot(declaredRoot);
    rootRecord.repoKey = repoKey;
    rootRecord.disposition = 'scanned';
    const projectRoot = join(declaredRoot, '.ensemble');
    const projectType = await pathKind(projectRoot);
    if (projectType === 'missing') {
      rootRecord.reason = 'No project-local .ensemble directory was present.';
      continue;
    }
    if (projectType !== 'directory') {
      rootRecord.disposition = 'unresolved';
      rootRecord.reason =
        projectType === 'symlink'
          ? 'Project-local .ensemble is a symlink and was not followed.'
          : 'Project-local .ensemble is not a regular directory.';
      manifest.checkoutInventory.unresolvedRoots.push(declaredRoot);
      continue;
    }
    const excludedPiTranscriptIds = await legacyPiOperatorSessionIds({
      userRoot,
      repoKey,
      projectRoot,
    });
    await scanSessionDirectory({
      directory: join(projectRoot, 'sessions'),
      repoKey,
      sourceType: 'project-local',
      checkoutRoot: declaredRoot,
      userRoot,
      excludedPiTranscriptIds,
      manifest,
      storeIndex,
      copyCandidates,
      linkedTasks,
    });
    linkedTasks.push({
      repoKey,
      userRoot,
      provenance: makeProvenance('project-local', repoKey, declaredRoot),
      toolCallFiles: [],
      sidecarDirectories: [],
      piDirectories: [join(projectRoot, 'pi', 'sessions')],
      excludedPiTranscriptIds,
    });
  }
  manifest.checkoutInventory.complete = checkoutRootsComplete;
  for (const root of manifest.checkoutInventory.declaredRoots) {
    root.inventoryConfirmed = checkoutRootsComplete;
  }
  for (const entry of manifest.entries) {
    if (entry.provenance?.sourceType === 'project-local') {
      entry.provenance.checkoutInventoryConfirmed = checkoutRootsComplete;
    }
  }
  if (!checkoutRootsComplete) {
    manifest.checkoutInventory.unconfirmedRoots = [...checkoutRoots];
    if (checkoutRoots.length === 0) {
      manifest.checkoutInventory.unconfirmedRoots = ['<no checkout roots declared>'];
    }
  }
}

async function scanCanonicalSessionStoreEvidence({
  userRoot,
  manifest,
  storeIndex,
}) {
  const githubRoot = join(userRoot, 'sessions', 'github.com');
  const owners = await listDirectory(
    githubRoot,
    manifest,
    'canonical-session-store-evidence-directory',
    { sourceType: 'canonical-slug-evidence' },
  );
  for (const ownerEntry of owners) {
    const ownerPath = join(githubRoot, ownerEntry.name);
    if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) {
      unresolvedEntry(
        manifest,
        ownerPath,
        'canonical-session-store-evidence-directory',
        'Canonical slug evidence directory is not a regular directory.',
        { sourceType: 'canonical-slug-evidence' },
      );
      continue;
    }
    const repositories = await listDirectory(
      ownerPath,
      manifest,
      'canonical-session-store-evidence-directory',
      { sourceType: 'canonical-slug-evidence', owner: ownerEntry.name },
    );
    for (const repositoryEntry of repositories) {
      const repositoryPath = join(ownerPath, repositoryEntry.name);
      if (repositoryEntry.isSymbolicLink() || !repositoryEntry.isDirectory()) {
        unresolvedEntry(
          manifest,
          repositoryPath,
          'canonical-session-store-evidence-directory',
          'Canonical repository evidence directory is not a regular directory.',
          {
            sourceType: 'canonical-slug-evidence',
            owner: ownerEntry.name,
          },
        );
        continue;
      }
      for (const storeEntry of await listDirectory(
        repositoryPath,
        manifest,
        'canonical-session-store-evidence-directory',
        {
          sourceType: 'canonical-slug-evidence',
          canonicalSlug: join(
            'github.com',
            ownerEntry.name,
            repositoryEntry.name,
          ),
        },
      )) {
        if (!storeEntry.name.endsWith('.json')) continue;
        const source = join(repositoryPath, storeEntry.name);
        const conductorAgentId = storeEntry.name.slice(0, -'.json'.length);
        const sourceInfo = await readSource(
          source,
          manifest,
          'canonical-session-store-evidence',
          { sourceType: 'canonical-slug-evidence' },
        );
        if (!sourceInfo) {
          addStoreCandidate(storeIndex, '*', conductorAgentId, {
            issue: undefined,
            source,
          });
          continue;
        }
        let value;
        try {
          value = JSON.parse(sourceInfo.bytes.toString('utf8'));
        } catch {
          value = undefined;
        }
        const issue =
          isRecord(value) &&
          value.conductorAgentId === conductorAgentId &&
          isSafePathSegment(conductorAgentId)
            ? parseIssueUrl(value.issueUrl)
            : undefined;
        const expectedSlug = join(
          'github.com',
          ownerEntry.name.toLowerCase(),
          repositoryEntry.name.toLowerCase(),
        );
        addStoreCandidate(storeIndex, '*', conductorAgentId, {
          issue:
            ownerEntry.name === ownerEntry.name.toLowerCase() &&
            repositoryEntry.name === repositoryEntry.name.toLowerCase() &&
            issue?.slug === expectedSlug
              ? issue
              : undefined,
          source,
          sourceSha256: sourceInfo.sha,
        });
      }
    }
  }
}

function addArchiveCandidate({
  archiveCandidates,
  manifest,
  userRoot,
  source,
  sourceSha,
  bytes,
  kind,
  reason,
  provenance,
  evidence = {},
  collisionReason,
  sourceBundleSha,
  intendedDestination,
  manifestEntry,
}) {
  const archiveSha = sha256(bytes);
  const destination = join(
    userRoot,
    'operator-agents',
    'legacy',
    'watch',
    `${archiveSha}.json`,
  );
  const entry =
    manifestEntry ??
    addManifestEntry(manifest, {
      source,
      destination,
      intendedDestination,
      kind,
      disposition: 'pending',
      reason,
      sourceSha256: sourceSha,
      sourceBundleSha256: sourceBundleSha ?? archiveSha,
      destinationBundleSha256: archiveSha,
      archiveReason: reason,
      collisionReason,
      recovery:
        'The archived watch bundle is checksum-addressed under operator-agents/legacy/watch. Keep the original source; restore the complete bundle only after selecting its profile and confirming its Issue URL.',
      provenance,
      evidence,
    });
  if (manifestEntry) {
    entry.destination = destination;
    entry.intendedDestination = intendedDestination ?? null;
    entry.disposition = 'pending';
    entry.reason = reason;
    entry.destinationBundleSha256 = archiveSha;
    entry.archiveReason = reason;
    entry.collisionReason = collisionReason ?? null;
    entry.recovery =
      'The archived watch bundle is checksum-addressed under operator-agents/legacy/watch. Keep the original source; restore the complete bundle only after selecting its profile and confirming its Issue URL.';
  }
  archiveCandidates.push({
    source,
    sourceSha,
    bytes,
    destination,
    archiveSha,
    entry,
    kind,
    provenance,
    userRoot,
  });
}

async function scanWatchSource({
  source,
  repoKey,
  sourceType,
  checkoutRoot,
  userRoot,
  profile,
  manifest,
  storeIndex,
  watchGroups,
  archiveCandidates,
}) {
  const provenance = makeProvenance(sourceType, repoKey, checkoutRoot);
  const sourceInfo = await readSource(
    source,
    manifest,
    'operator-watch-state',
    provenance,
  );
  if (!sourceInfo) return;
  let parsed;
  try {
    parsed = JSON.parse(sourceInfo.bytes.toString('utf8'));
  } catch {
    addArchiveCandidate({
      archiveCandidates,
      manifest,
      userRoot,
      source,
      sourceSha: sourceInfo.sha,
      bytes: sourceInfo.bytes,
      kind: 'operator-watch-state',
      reason: 'Watch state is invalid JSON and cannot be safely split into bundles.',
      provenance,
    });
    return;
  }
  const normalized = normalizeWatchState(parsed);
  if (!normalized) {
    addArchiveCandidate({
      archiveCandidates,
      manifest,
      userRoot,
      source,
      sourceSha: sourceInfo.sha,
      bytes: sourceInfo.bytes,
      kind: 'operator-watch-state',
      reason:
        'Watch state has an unsupported or malformed structure; the original file is archived intact.',
      provenance,
    });
    return;
  }
  if (normalized.ids.length === 0) {
    addManifestEntry(manifest, {
      source,
      kind: 'operator-watch-state',
      disposition: 'empty',
      reason: 'Watch state contains no session bundle to migrate.',
      sourceSha256: sourceInfo.sha,
      recovery: 'No recovery action is needed; the source remains in place.',
      provenance,
    });
    return;
  }

  for (const conductorAgentId of normalized.ids) {
    const bundle = extractWatchBundle(normalized.state, conductorAgentId);
    const bundleBytes = Buffer.from(serializeWatchState(bundle), 'utf8');
    const bundleSha = sha256(bundleBytes);
    const evidence = storeEvidence(storeIndex, repoKey, conductorAgentId);
    const reports = bundle.pendingReports;
    const reportIssues = reports.map((report) =>
      parseIssueUrl(report.issueUrl),
    );
    let reason;
    if (
      evidence.hasInvalid ||
      evidence.candidates.length === 0 ||
      evidence.issueUrls.size !== 1 ||
      !evidence.issue
    ) {
      reason =
        'A unique valid SessionResumeStore issueUrl is required to prove the watch bundle slug.';
    } else if (
      reportIssues.some(
        (issue) => !issue || issue.canonicalUrl !== evidence.issueUrl,
      )
    ) {
      reason =
        'At least one pending report Issue URL is invalid or differs from the matching SessionResumeStore issueUrl.';
    } else if (!profile) {
      reason =
        'No operator-selected profile was supplied for this watch bundle.';
    }

    const intendedDestination =
      evidence.issue && profile
        ? join(
            userRoot,
            'operator-agents',
            profile,
            'watch',
            evidence.issue.slug,
            'watch-state.json',
          )
        : undefined;
    const bundleEvidence = {
      conductorAgentId,
      ...(evidence.issueUrl ? { issueUrl: evidence.issueUrl } : {}),
      ...(evidence.slug ? { canonicalSlug: evidence.slug } : {}),
      ...(profile ? { operatorSelectedProfile: profile } : {}),
      sessionStoreSources: evidence.storeSources,
      pendingReportIssueUrls: reports.map((report) => report.issueUrl),
    };
    if (reason) {
      addArchiveCandidate({
        archiveCandidates,
        manifest,
        userRoot,
        source,
        sourceSha: sourceInfo.sha,
        bytes: bundleBytes,
        sourceBundleSha: bundleSha,
        kind: 'operator-watch-bundle',
        reason,
        provenance: { ...provenance, conductorAgentId },
        evidence: bundleEvidence,
        intendedDestination,
      });
      continue;
    }

    const group = watchGroups.get(intendedDestination) ?? {
      destination: intendedDestination,
      bundles: [],
    };
    const entry = addManifestEntry(manifest, {
      source,
      destination: intendedDestination,
      kind: 'operator-watch-bundle',
      disposition: 'pending',
      sourceSha256: sourceInfo.sha,
      sourceBundleSha256: bundleSha,
      recovery:
        'Watch cursors, listeners and pending reports are copied as one conductorAgentId bundle. If the destination differs, the bundle is preserved under operator-agents/legacy/watch.',
      provenance: { ...provenance, conductorAgentId },
      evidence: bundleEvidence,
    });
    group.bundles.push({
      id: conductorAgentId,
      bytes: bundleBytes,
      sha: bundleSha,
      source,
      sourceSha: sourceInfo.sha,
      sourceType,
      bundle,
      entry,
      provenance: { ...provenance, conductorAgentId },
      evidence: bundleEvidence,
    });
    watchGroups.set(intendedDestination, group);
  }
}

async function scanHashWatchSources({
  userRoot,
  profile,
  manifest,
  storeIndex,
  watchGroups,
  archiveCandidates,
}) {
  const operatorRoot = join(userRoot, 'operator-agent');
  const entries = await listDirectory(
    operatorRoot,
    manifest,
    'legacy-operator-state-root',
    { sourceType: 'user-path-hash' },
  );
  for (const entry of entries) {
    if (!HASH_DIRECTORY_RE.test(entry.name)) continue;
    const directory = join(operatorRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      unresolvedEntry(
        manifest,
        directory,
        'legacy-operator-watch-root',
        'Legacy watch source root is not a regular directory.',
        { sourceType: 'user-path-hash', repoKey: entry.name },
      );
      continue;
    }
    const source = join(directory, 'watch-state.json');
    if ((await pathKind(source)) === 'missing') continue;
    await scanWatchSource({
      source,
      repoKey: entry.name,
      sourceType: 'user-path-hash',
      userRoot,
      profile,
      manifest,
      storeIndex,
      watchGroups,
      archiveCandidates,
    });
  }
}

async function scanProjectWatchSources({
  checkoutInventory,
  profile,
  userRoot,
  manifest,
  storeIndex,
  watchGroups,
  archiveCandidates,
}) {
  for (const root of checkoutInventory.declaredRoots) {
    if (root.disposition !== 'scanned') continue;
    const source = join(root.path, '.ensemble', 'operator-agent', 'watch-state.json');
    if ((await pathKind(source)) === 'missing') continue;
    await scanWatchSource({
      source,
      repoKey: root.repoKey,
      sourceType: 'project-local',
      checkoutRoot: root.path,
      userRoot,
      profile,
      manifest,
      storeIndex,
      watchGroups,
      archiveCandidates,
    });
  }
}

function buildWatchStateFromBundles(bundles) {
  const state = emptyWatchState();
  for (const item of [...bundles].sort((a, b) => a.id.localeCompare(b.id))) {
    const bundle = item.bundle;
    for (const key of [
      'watches',
      'cursors',
      'messageListeners',
      'messageCursors',
    ]) {
      if (Object.hasOwn(bundle[key], item.id)) {
        state[key][item.id] = bundle[key][item.id];
      }
    }
    state.pendingReports.push(...bundle.pendingReports);
  }
  return state;
}

async function verifySourceUnchanged(source, expectedSha) {
  try {
    if ((await pathKind(source)) !== 'file') return false;
    return (await hashFile(source)) === expectedSha;
  } catch {
    return false;
  }
}

async function existingFileInfo(path, { includeBytes = false } = {}) {
  const type = await pathKind(path);
  if (type === 'missing') return { exists: false };
  if (type !== 'file') {
    return { exists: true, type, sha: undefined, bytes: undefined };
  }
  try {
    const sha = await hashFile(path);
    return {
      exists: true,
      type,
      ...(includeBytes ? { bytes: await readFile(path) } : {}),
      sha,
    };
  } catch {
    return { exists: true, type: 'unreadable', sha: undefined, bytes: undefined };
  }
}

async function ensureParentDirectory(path, userRoot) {
  const root = normalize(resolve(userRoot));
  const destination = normalize(resolve(path));
  const parent = normalize(resolve(dirname(destination)));
  if (!isWithin(root, destination) || !isWithin(root, parent)) {
    throw new Error(`Destination escapes user root: ${destination}`);
  }
  let rootType = await pathKind(root);
  if (rootType === 'missing') {
    await mkdir(root, { recursive: true, mode: 0o700 });
    rootType = await pathKind(root);
  }
  if (rootType !== 'directory') {
    throw new Error(`User root is not a regular directory: ${root}`);
  }
  const relativeParent = relative(root, parent);
  let current = root;
  for (const segment of relativeParent === '' ? [] : relativeParent.split(sep)) {
    current = join(current, segment);
    let type = await pathKind(current);
    if (type === 'missing') {
      await mkdir(current, { mode: 0o700 });
      type = await pathKind(current);
    }
    if (type !== 'directory') {
      throw new Error(
        `Destination parent is not a regular directory: ${current}`,
      );
    }
    await chmod(current, 0o700).catch(() => {});
  }
}

async function writeExclusive(path, bytes, userRoot) {
  await ensureParentDirectory(path, userRoot);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

function setDisposition(entry, disposition, details = {}) {
  Object.assign(entry, {
    disposition,
    reason: details.reason ?? entry.reason ?? null,
    destinationSha256:
      details.destinationSha256 ?? entry.destinationSha256 ?? null,
    collisionReason: details.collisionReason ?? entry.collisionReason ?? null,
    archiveReason: details.archiveReason ?? entry.archiveReason ?? null,
    recovery: details.recovery ?? entry.recovery ?? null,
  });
}

async function applyFileCopy(candidate, mode, userRoot) {
  const entry = candidate.manifestEntry;
  const sourceUnchanged = await verifySourceUnchanged(
    candidate.source,
    candidate.sourceSha,
  );
  if (!sourceUnchanged) {
    setDisposition(entry, 'unresolved', {
      reason: 'Source changed or became unreadable after inventory.',
      recovery:
        'Keep the source and destination unchanged, rerun dry-run, and review the new checksums.',
    });
    return;
  }
  const existing = await existingFileInfo(candidate.destination);
  if (existing.exists) {
    if (existing.sha === candidate.sourceSha) {
      setDisposition(entry, 'no-op-identical', {
        destinationSha256: existing.sha,
        reason: 'Destination already has the same SHA-256 checksum.',
      });
    } else {
      setDisposition(entry, 'collision', {
        destinationSha256: existing.sha,
        collisionReason:
          existing.type === 'file'
            ? 'Destination exists with a different checksum.'
            : `Destination exists as ${existing.type}, not a regular file.`,
        reason:
          existing.type === 'file'
            ? 'Destination exists with a different checksum.'
            : `Destination exists as ${existing.type}, not a regular file.`,
        recovery:
          'Keep both source and destination. Compare provenance and checksums, then choose a recovery copy manually.',
      });
    }
    return;
  }
  if (mode === 'dry-run') {
    setDisposition(entry, 'planned-copy', {
      destinationSha256: candidate.sourceSha,
      reason: 'Destination is absent; copy is planned.',
    });
    return;
  }

  try {
    if ((await hashFile(candidate.source)) !== candidate.sourceSha) {
      setDisposition(entry, 'unresolved', {
        reason: 'Source changed immediately before copy.',
        recovery:
          'Keep the source and destination unchanged, rerun dry-run, and review the new checksums.',
      });
      return;
    }
    await ensureParentDirectory(candidate.destination, userRoot);
    await copyFile(
      candidate.source,
      candidate.destination,
      fsConstants.COPYFILE_EXCL,
    );
    await chmod(candidate.destination, 0o600).catch(() => {});
    const destinationSha = await hashFile(candidate.destination);
    const sourceAfterSha = await hashFile(candidate.source);
    if (
      destinationSha !== candidate.sourceSha ||
      sourceAfterSha !== candidate.sourceSha
    ) {
      setDisposition(entry, 'copy-unverified', {
        destinationSha256: destinationSha,
        reason:
          'Post-copy source or destination SHA-256 did not match the inventory checksum.',
        recovery:
          'Do not remove either file. Inspect both checksums and restore manually if needed.',
      });
      return;
    }
    setDisposition(entry, 'copied', {
      destinationSha256: destinationSha,
      reason: 'Source and destination SHA-256 checksums match.',
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      ['EEXIST', 'ERR_FS_CP_EEXIST'].includes(error.code)
    ) {
      const raced = await existingFileInfo(candidate.destination);
      if (raced.sha === candidate.sourceSha) {
        setDisposition(entry, 'no-op-identical', {
          destinationSha256: raced.sha,
          reason: 'Destination appeared during apply with the same checksum.',
        });
      } else {
        setDisposition(entry, 'collision', {
          destinationSha256: raced.sha,
          collisionReason:
            'Destination appeared during apply and differs from the source.',
          reason:
            'Destination appeared during apply and differs from the source.',
          recovery:
            'Keep both files and inspect their checksums before choosing a recovery copy.',
        });
      }
      return;
    }
    setDisposition(entry, 'copy-failed', {
      reason: `Copy failed: ${error.message}`,
      recovery:
        'Keep the source. Resolve the filesystem error and rerun; existing destinations will not be overwritten.',
    });
  }
}

async function applyArchiveCandidate(candidate, mode, userRoot) {
  const { entry } = candidate;
  if (
    !(await verifySourceUnchanged(candidate.source, candidate.sourceSha))
  ) {
    setDisposition(entry, 'unresolved', {
      reason: 'Source changed or became unreadable after inventory.',
      recovery:
        'Keep the source and rerun dry-run to inventory the current watch bundle.',
    });
    return;
  }
  const existing = await existingFileInfo(candidate.destination);
  if (existing.exists) {
    if (existing.sha === candidate.archiveSha) {
      setDisposition(entry, 'no-op-identical', {
        destinationSha256: existing.sha,
        reason: 'Checksum-addressed archive already contains this exact bundle.',
      });
    } else {
      setDisposition(entry, 'collision', {
        destinationSha256: existing.sha,
        collisionReason:
          'Checksum-addressed archive path exists with different contents.',
        reason:
          'Checksum-addressed archive path exists with different contents.',
        recovery:
          'Keep the source and existing archive. Choose another archive path before retrying.',
      });
    }
    return;
  }
  if (mode === 'dry-run') {
    setDisposition(entry, 'planned-archive', {
      destinationSha256: candidate.archiveSha,
      reason: 'Checksum-addressed archive copy is planned.',
    });
    return;
  }
  try {
    if (sha256(await readFile(candidate.source)) !== candidate.sourceSha) {
      setDisposition(entry, 'unresolved', {
        reason: 'Source changed immediately before archive copy.',
        recovery:
          'Keep the source and rerun dry-run to inventory the current watch bundle.',
      });
      return;
    }
    await writeExclusive(candidate.destination, candidate.bytes, userRoot);
    const destinationBytes = await readFile(candidate.destination);
    const sourceAfter = await readFile(candidate.source);
    const destinationSha = sha256(destinationBytes);
    if (
      destinationSha !== candidate.archiveSha ||
      sha256(sourceAfter) !== candidate.sourceSha
    ) {
      setDisposition(entry, 'copy-unverified', {
        destinationSha256: destinationSha,
        reason: 'Archive copy failed SHA-256 verification.',
        recovery:
          'Do not remove either copy. Compare source, bundle and archive checksums and recover manually.',
      });
      return;
    }
    setDisposition(entry, 'archived', {
      destinationSha256: destinationSha,
      reason: 'Watch bundle archived and checksum verified.',
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      const raced = await existingFileInfo(candidate.destination);
      if (raced.sha === candidate.archiveSha) {
        setDisposition(entry, 'no-op-identical', {
          destinationSha256: raced.sha,
          reason: 'Identical archive appeared during apply.',
        });
      } else {
        setDisposition(entry, 'collision', {
          destinationSha256: raced.sha,
          collisionReason:
            'Archive path appeared during apply with different contents.',
          reason:
            'Archive path appeared during apply with different contents.',
          recovery:
            'Keep both files and choose another archive path before retrying.',
        });
      }
      return;
    }
    setDisposition(entry, 'copy-failed', {
      reason: `Archive copy failed: ${error.message}`,
      recovery:
        'Keep the source and rerun after resolving the filesystem error.',
    });
  }
}

function watchStateFromBytes(bytes) {
  try {
    const normalized = normalizeWatchState(JSON.parse(bytes.toString('utf8')));
    return normalized?.state;
  } catch {
    return undefined;
  }
}

function addWatchArchive(
  archiveCandidates,
  userRoot,
  manifest,
  item,
  reason,
  collisionReason,
) {
  addArchiveCandidate({
    archiveCandidates,
    manifest,
    userRoot,
    source: item.source,
    sourceSha: item.sourceSha,
    bytes: item.bytes,
    sourceBundleSha: item.sha,
    kind: 'operator-watch-bundle',
    reason,
    collisionReason,
    provenance: item.provenance,
    evidence: item.evidence,
    intendedDestination: item.entry.destination,
    manifestEntry: item.entry,
  });
}

async function executeWatchGroup(
  group,
  { mode, userRoot, manifest, archiveCandidates },
) {
  const bundlesById = new Map();
  for (const item of group.bundles) {
    const candidates = bundlesById.get(item.id) ?? [];
    candidates.push(item);
    bundlesById.set(item.id, candidates);
  }

  const eligible = [];
  for (const [id, items] of bundlesById) {
    const distinct = new Set(items.map((item) => item.sha));
    if (distinct.size > 1) {
      for (const item of items) {
        addWatchArchive(
          archiveCandidates,
          userRoot,
          manifest,
          item,
          'Conflicting source bundles share the same conductorAgentId and target slug.',
          'Different watch bundles from the inventory collide at one profile/slug destination.',
        );
      }
      continue;
    }
    eligible.push({ primary: items[0], duplicates: items.slice(1) });
  }
  if (eligible.length === 0) return;

  const existing = await existingFileInfo(group.destination, {
    includeBytes: true,
  });
  if (existing.exists) {
    const existingState =
      existing.type === 'file' && existing.bytes
        ? watchStateFromBytes(existing.bytes)
        : undefined;
    for (const { primary, duplicates } of eligible) {
      const existingBundle = existingState
        ? extractWatchBundle(existingState, primary.id)
        : undefined;
      const matches =
        existingBundle &&
        sha256(Buffer.from(serializeWatchState(existingBundle), 'utf8')) ===
          primary.sha;
      if (matches) {
        for (const item of [primary, ...duplicates]) {
          setDisposition(item.entry, 'no-op-identical', {
            destinationSha256: existing.sha,
            destinationBundleSha256: primary.sha,
            reason:
              'Destination already contains the same complete watch bundle.',
          });
        }
      } else {
        for (const item of [primary, ...duplicates]) {
          addWatchArchive(
            archiveCandidates,
            userRoot,
            manifest,
            item,
            'Existing profile/slug watch-state destination cannot be overwritten or merged.',
            existing.type === 'file'
              ? 'Destination exists with a different watch bundle or other session data.'
              : `Destination exists as ${existing.type}, not a regular watch-state file.`,
          );
        }
      }
    }
    return;
  }

  const copyItems = eligible.map(({ primary }) => primary);
  const outputBytes = Buffer.from(
    serializeWatchState(
      buildWatchStateFromBundles(
        copyItems.map((item) => ({
          ...item,
          bundle: item.bundle,
        })),
      ),
    ),
    'utf8',
  );
  const outputSha = sha256(outputBytes);
  if (mode === 'dry-run') {
    for (const { primary, duplicates } of eligible) {
      setDisposition(primary.entry, 'planned-copy', {
        destinationSha256: outputSha,
        destinationBundleSha256: primary.sha,
        reason: 'Complete watch bundle is included in the planned destination.',
      });
      for (const duplicate of duplicates) {
        setDisposition(duplicate.entry, 'no-op-identical', {
          destinationSha256: outputSha,
          destinationBundleSha256: duplicate.sha,
          reason:
            'The same watch bundle is already included from another source.',
        });
      }
    }
    return;
  }

  const guards = new Map();
  for (const { primary, duplicates } of eligible) {
    for (const item of [primary, ...duplicates]) {
      if (guards.has(item.source)) continue;
      guards.set(item.source, item.sourceSha);
    }
  }
  let changedSource;
  for (const [source, expectedSha] of guards) {
    if (!(await verifySourceUnchanged(source, expectedSha))) {
      changedSource = source;
      break;
    }
  }
  if (changedSource) {
    for (const { primary, duplicates } of eligible) {
      for (const item of [primary, ...duplicates]) {
        setDisposition(item.entry, 'unresolved', {
          reason:
            item.source === changedSource
              ? 'Source changed after inventory.'
              : `Another source in the combined watch destination changed: ${changedSource}`,
          recovery:
            'Keep all sources. Rerun dry-run and review every bundle targeting this profile/slug.',
        });
      }
    }
    return;
  }

  try {
    await writeExclusive(group.destination, outputBytes, userRoot);
    const destinationBytes = await readFile(group.destination);
    const destinationSha = sha256(destinationBytes);
    let sourceChanged = false;
    for (const [source, expectedSha] of guards) {
      if (!(await verifySourceUnchanged(source, expectedSha))) {
        sourceChanged = true;
        break;
      }
    }
    if (destinationSha !== outputSha || sourceChanged) {
      for (const { primary, duplicates } of eligible) {
        setDisposition(primary.entry, 'copy-unverified', {
          destinationSha256: destinationSha,
          destinationBundleSha256: primary.sha,
          reason: destinationSha !== outputSha
            ? 'Combined watch-state destination failed SHA-256 verification.'
            : 'A source changed during the combined watch-state copy.',
          recovery:
            'Do not remove the destination or sources. Compare the recorded bundle and destination checksums.',
        });
        for (const duplicate of duplicates) {
          setDisposition(duplicate.entry, 'copy-unverified', {
            destinationSha256: destinationSha,
            destinationBundleSha256: duplicate.sha,
            reason: 'Combined watch-state destination failed SHA-256 verification.',
          });
        }
      }
      return;
    }
    for (const { primary, duplicates } of eligible) {
      setDisposition(primary.entry, 'copied', {
        destinationSha256: destinationSha,
        destinationBundleSha256: primary.sha,
        reason: 'Combined watch-state destination checksum verified.',
      });
      for (const duplicate of duplicates) {
        setDisposition(duplicate.entry, 'no-op-identical', {
          destinationSha256: destinationSha,
          destinationBundleSha256: duplicate.sha,
          reason:
            'The same watch bundle was already included from another source.',
        });
      }
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      const raced = await existingFileInfo(group.destination, {
        includeBytes: true,
      });
      const racedState =
        raced.type === 'file' && raced.bytes
          ? watchStateFromBytes(raced.bytes)
          : undefined;
      for (const { primary, duplicates } of eligible) {
        const racedBundle = racedState
          ? extractWatchBundle(racedState, primary.id)
          : undefined;
        const matches =
          racedBundle &&
          sha256(Buffer.from(serializeWatchState(racedBundle), 'utf8')) ===
            primary.sha;
        if (matches) {
          for (const item of [primary, ...duplicates]) {
            setDisposition(item.entry, 'no-op-identical', {
              destinationSha256: raced.sha,
              reason:
                'Identical watch bundle appeared in the destination during apply.',
            });
          }
        } else {
          for (const item of [primary, ...duplicates]) {
            addWatchArchive(
              archiveCandidates,
              userRoot,
              manifest,
              item,
              'Destination appeared during apply and cannot be overwritten or merged.',
              'Destination appeared with a different watch bundle.',
            );
          }
        }
      }
      return;
    }
    for (const { primary, duplicates } of eligible) {
      setDisposition(primary.entry, 'copy-failed', {
        reason: `Watch-state copy failed: ${error.message}`,
        recovery:
          'Keep every source. Resolve the filesystem error and rerun; destinations are never overwritten.',
      });
      for (const duplicate of duplicates) {
        setDisposition(duplicate.entry, 'copy-failed', {
          reason: `Watch-state copy failed: ${error.message}`,
        });
      }
    }
  }
}

async function assertManifestPathSafe(manifestPath, userRoot, checkoutRoots) {
  const protectedRoots = [
    join(userRoot, 'sessions'),
    join(userRoot, 'operator-agent'),
    join(userRoot, 'operator-agents'),
    ...checkoutRoots.map((root) => join(root, '.ensemble')),
  ].map((path) => normalize(resolve(path)));
  if (
    protectedRoots.some((root) =>
      isWithin(root, normalize(resolve(manifestPath))),
    )
  ) {
    throw new Error(
      `Manifest path must be outside migration source and destination data roots: ${manifestPath}`,
    );
  }
}

async function writeManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => {});
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    usage();
    return;
  }
  await assertManifestPathSafe(
    options.manifest,
    options.userRoot,
    options.checkoutRoots,
  );
  if ((await pathKind(options.manifest)) !== 'missing') {
    throw new Error(
      `Manifest path already exists; choose a new path to preserve the previous inventory: ${options.manifest}`,
    );
  }

  const manifest = {
    schemaVersion: 1,
    tool: 'migrate-project-ensemble-runtime-to-user',
    runAt: new Date().toISOString(),
    mode: options.mode,
    userRoot: options.userRoot,
    operatorSelectedProfile: options.profile ?? null,
    checkoutInventory: {
      complete: options.checkoutRootsComplete,
      completeness:
        options.checkoutRootsComplete
          ? 'operator-asserted-complete'
          : 'not-confirmed',
      declaredRoots: [],
      unresolvedRoots: [],
      unconfirmedRoots: [],
    },
    entries: [],
    unresolvedSources: [],
  };
  const storeIndex = new Map();
  const copyCandidates = [];
  const linkedTasks = [];
  const watchGroups = new Map();
  const archiveCandidates = [];

  await scanHashSessionRoots({
    userRoot: options.userRoot,
    manifest,
    storeIndex,
    copyCandidates,
    linkedTasks,
  });
  await scanCheckoutRoots({
    checkoutRoots: options.checkoutRoots,
    checkoutRootsComplete: options.checkoutRootsComplete,
    userRoot: options.userRoot,
    manifest,
    storeIndex,
    copyCandidates,
    linkedTasks,
  });
  await scanCanonicalSessionStoreEvidence({
    userRoot: options.userRoot,
    manifest,
    storeIndex,
  });
  for (const task of linkedTasks) {
    await processLinkedSessionData({
      task,
      manifest,
      storeIndex,
      copyCandidates,
    });
  }
  await scanHashWatchSources({
    userRoot: options.userRoot,
    profile: options.profile,
    manifest,
    storeIndex,
    watchGroups,
    archiveCandidates,
  });
  await scanProjectWatchSources({
    checkoutInventory: manifest.checkoutInventory,
    profile: options.profile,
    userRoot: options.userRoot,
    manifest,
    storeIndex,
    watchGroups,
    archiveCandidates,
  });

  for (const candidate of copyCandidates) {
    await applyFileCopy(candidate, options.mode, options.userRoot);
  }
  for (const group of watchGroups.values()) {
    await executeWatchGroup(group, {
      mode: options.mode,
      userRoot: options.userRoot,
      manifest,
      archiveCandidates,
    });
  }
  for (const candidate of archiveCandidates) {
    await applyArchiveCandidate(candidate, options.mode, options.userRoot);
  }

  manifest.unresolvedSources = manifest.entries
    .filter((entry) =>
      [
        'unresolved',
        'copy-unverified',
        'copy-failed',
      ].includes(entry.disposition),
    )
    .map((entry) => ({
      source: entry.source,
      destination: entry.destination,
      kind: entry.kind,
      disposition: entry.disposition,
      reason: entry.reason,
      sourceSha256: entry.sourceSha256,
      destinationSha256: entry.destinationSha256,
      recovery: entry.recovery,
    }));
  manifest.summary = manifest.entries.reduce(
    (summary, entry) => {
      summary.total += 1;
      summary[entry.disposition] =
        (summary[entry.disposition] ?? 0) + 1;
      return summary;
    },
    { total: 0 },
  );
  await writeManifest(options.manifest, manifest);
  process.stdout.write(
    `${options.mode}: ${manifest.summary.total} source entries; manifest ${options.manifest}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
