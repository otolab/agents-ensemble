import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findPiConductorSessionFile } from '../conductor/pi-conductor-session-file.js';
import { readCursorConductorRunSnapshots } from '../conductor/cursor-run-snapshots.js';
import {
  resolveEnsemblePaths,
  type EnsemblePaths,
} from '../ensemble-paths.js';
import {
  findSessionResumeStore,
  harnessPhaseFromLegacyLifecycle,
  type LocatedSessionResumeStore,
  type SessionResumeStore,
} from './session-resume-store.js';
import { sessionSnapshotPaths } from './session-snapshot-paths.js';
import {
  getWorkerSessionHistoryReaderSupport,
  readWorkerSessionHistory,
  type WorkerSessionHistoryResult,
} from './worker-session-history.js';

export type SessionBundleStatus = 'complete' | 'partial';

export type SessionBundleSourceStatus =
  | 'copied'
  | 'available'
  | 'partial'
  | 'unavailable'
  | 'unsupported'
  | 'not-requested';

export interface SessionBundleFile {
  /** Path relative to the bundle root. */
  path: string;
  kind: 'raw' | 'json';
  sizeBytes: number;
  sha256: string;
  /** Absolute source paths. Empty for data retrieved through the Cursor SDK. */
  sourcePaths: string[];
}

export interface SessionBundleSource {
  id: string;
  status: SessionBundleSourceStatus;
  sourcePaths: string[];
  bundlePaths: string[];
  reason?: string;
}

export interface SessionBundleManifest {
  schemaVersion: 1;
  exportedAt: string;
  versions: {
    ensemble: string;
    cli: string;
  };
  session: {
    conductorAgentId: string;
    issueUrl: string;
    repoRoot: string;
    conductorCwd: string;
    backend: 'cursor' | 'pi';
    createdHarnessCliVersion?: string;
    lifecycle: string;
    harnessPhase: string | null;
    updatedAt: number;
    resumeStoreLocation: LocatedSessionResumeStore['location'];
    workers: Array<{
      name: string;
      kind: string;
      preset: string | null;
      reader: string | null;
      acpSessionId: string;
      acpCwd: string | null;
      bundlePath: string;
    }>;
  };
  /** Payload files only; manifest.json is not listed to avoid a recursive hash. */
  files: SessionBundleFile[];
  /** Includes unavailable and not-requested sources so omissions are explicit. */
  sources: SessionBundleSource[];
  warnings: string[];
}

export interface ExportSessionBundleResult {
  status: SessionBundleStatus;
  outputDirectory: string;
  manifestPath: string;
  fileCount: number;
  warnings: string[];
  manifest: SessionBundleManifest;
}

export interface ExportSessionBundleInput {
  repoRoot: string;
  conductorAgentId: string;
  outputDirectory: string;
  ensembleVersion: string;
  cliVersion: string;
  includeToolCalls?: boolean;
  summaryPath?: string;
  harnessLogPath?: string;
  now?: () => Date;
}

interface CopyResult {
  sizeBytes: number;
  sha256: string;
  sourceChangedDuringCopy: boolean;
}

interface SourceCandidateResult {
  path?: string;
  reason?: string;
  warnings: string[];
}

class SessionBundleSourceError extends Error {
  constructor(
    readonly kind: 'missing' | 'unsafe' | 'unavailable',
  ) {
    super(`Session bundle source could not be copied (${kind}).`);
    this.name = 'SessionBundleSourceError';
  }
}

/** Collect saved session data into a new bundle without modifying sources. */
export async function exportSessionBundle(
  input: ExportSessionBundleInput,
): Promise<ExportSessionBundleResult> {
  const repoRoot = resolve(input.repoRoot);
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const outputDirectory = resolve(input.outputDirectory);
  if (
    !input.ensembleVersion.trim() ||
    !input.cliVersion.trim()
  ) {
    throw new Error('ensembleVersion and cliVersion must be non-empty.');
  }

  const located = await findSessionResumeStore(repoRoot, conductorAgentId);
  if (
    !located ||
    resolve(located.resumeStore.repoRoot) !== repoRoot
  ) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

  await createNewBundleDirectory(outputDirectory);
  try {
    return await writeSessionBundle({
      input,
      repoRoot,
      conductorAgentId,
      outputDirectory,
      located,
    });
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function writeSessionBundle(input: {
  input: ExportSessionBundleInput;
  repoRoot: string;
  conductorAgentId: string;
  outputDirectory: string;
  located: LocatedSessionResumeStore;
}): Promise<ExportSessionBundleResult> {
  const { input: options, repoRoot, conductorAgentId, outputDirectory, located } =
    input;
  const resumeStore = located.resumeStore;
  const paths = resolveEnsemblePaths({ repoRoot });
  const files: SessionBundleFile[] = [];
  const sources: SessionBundleSource[] = [];
  const warnings: string[] = [];
  const exportedAt = (options.now?.() ?? new Date()).toISOString();
  const backend = resumeStore.conductorBackend ?? 'cursor';

  const resumeCopy = await copyRawSource({
    id: 'session.resumeStore',
    sourcePath: located.path,
    bundlePath: 'session/session-resume-store.json',
    outputDirectory,
    required: true,
    files,
    sources,
    warnings,
  });
  if (!resumeCopy) {
    throw new Error('The saved SessionResumeStore could not be copied.');
  }

  const harnessPhase =
    resumeStore.harnessPhase ??
    harnessPhaseFromLegacyLifecycle(resumeStore.lifecycle);
  if (harnessPhase === 'running' || harnessPhase === 'idle') {
    warnings.push(
      `この session の harness は稼働中です（phase: ${harnessPhase}）。export は読み取り専用の best-effort snapshot で、複数ファイルが同じ時点の内容であることは保証しません。`,
    );
  }

  if (backend === 'pi') {
    await exportPiConductorTranscript({
      repoRoot,
      resumeStore,
      conductorAgentId,
      outputDirectory,
      files,
      sources,
      warnings,
    });
  } else {
    await exportCursorConductorRuns({
      conductorAgentId,
      cwd: resumeStore.conductorCwd ?? resumeStore.repoRoot,
      outputDirectory,
      files,
      sources,
      warnings,
    });
  }

  const workerFiles: SessionBundleManifest['session']['workers'] = [];
  const profileWorkers = new Map(
    resumeStore.profile.workers.map((worker) => [worker.name, worker.kind]),
  );
  const workers = Object.entries(resumeStore.workers).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [index, [name, worker]] of workers.entries()) {
    const support = getWorkerSessionHistoryReaderSupport(
      worker.acpSpawn?.preset,
    );
    const workerPath = workerBundlePath(name, index);
    let history: WorkerSessionHistoryResult;
    try {
      history = await readWorkerSessionHistory({
        repoRoot,
        conductorAgentId,
        workerName: name,
        includeSourceFiles: true,
      });
    } catch {
      history = {
        conductorAgentId,
        worker: name,
        preset: worker.acpSpawn?.preset ?? null,
        reader: support.reader,
        status: 'unavailable',
        reason: 'Worker transcript reader failed unexpectedly.',
        messages: [],
        sourceFiles: [],
      };
      warnings.push(
        `Worker「${name}」の transcript reader が予期せず失敗しました。結果 JSON に理由を記録しました。`,
      );
    }

    const workerFile = await writeJsonPayload({
      outputDirectory,
      path: workerPath,
      value: history,
      sourcePaths: history.sourceFiles ?? [],
    });
    files.push(workerFile);
    sources.push({
      id: `worker.${name}`,
      status: sourceStatusFromWorkerHistory(history),
      sourcePaths: history.sourceFiles ?? [],
      bundlePaths: [workerPath],
      ...(history.reason ? { reason: history.reason } : {}),
    });
    if (history.status !== 'supported') {
      warnings.push(
        `Worker「${name}」の履歴は ${history.status} です。詳細は ${workerPath} を確認してください。`,
      );
    }
    workerFiles.push({
      name,
      kind: profileWorkers.get(name) ?? name,
      preset: worker.acpSpawn?.preset ?? null,
      reader: support.reader ?? null,
      acpSessionId: worker.acpSessionId,
      acpCwd: worker.acpCwd ?? null,
      bundlePath: workerPath,
    });
  }

  await exportSnapshotFile({
    id: 'harness.sessionState',
    candidates: sessionSnapshotPaths(repoRoot, located, 'session-state'),
    outputDirectory,
    bundlePath: 'harness/session-state.yaml',
    files,
    sources,
    warnings,
  });
  await exportSnapshotFile({
    id: 'harness.openQuestions',
    candidates: sessionSnapshotPaths(repoRoot, located, 'open-questions'),
    outputDirectory,
    bundlePath: 'harness/open-questions.yaml',
    files,
    sources,
    warnings,
  });
  await exportToolCallHistory({
    paths,
    conductorAgentId,
    include: options.includeToolCalls ?? false,
    outputDirectory,
    files,
    sources,
    warnings,
  });
  await exportOptionalInput({
    id: 'input.summary',
    sourcePath: options.summaryPath,
    bundlePath: 'inputs/session-summary.json',
    outputDirectory,
    files,
    sources,
    warnings,
  });
  await exportOptionalInput({
    id: 'input.harnessLog',
    sourcePath: options.harnessLogPath,
    bundlePath: 'inputs/harness.log',
    outputDirectory,
    files,
    sources,
    warnings,
  });

  const manifest: SessionBundleManifest = {
    schemaVersion: 1,
    exportedAt,
    versions: {
      ensemble: options.ensembleVersion,
      cli: options.cliVersion,
    },
    session: {
      conductorAgentId: resumeStore.conductorAgentId,
      issueUrl: resumeStore.issueUrl,
      repoRoot: resumeStore.repoRoot,
      conductorCwd: resumeStore.conductorCwd ?? resumeStore.repoRoot,
      backend,
      ...(resumeStore.createdHarnessCliVersion
        ? { createdHarnessCliVersion: resumeStore.createdHarnessCliVersion }
        : {}),
      lifecycle: resumeStore.lifecycle ?? 'unknown',
      harnessPhase,
      updatedAt: resumeStore.updatedAt,
      resumeStoreLocation: located.location,
      workers: workerFiles,
    },
    files,
    sources,
    warnings,
  };
  const manifestPath = join(outputDirectory, 'manifest.json');
  await writeBundleJsonFile(manifestPath, manifest);

  return {
    status: warnings.length === 0 ? 'complete' : 'partial',
    outputDirectory,
    manifestPath,
    fileCount: files.length,
    warnings,
    manifest,
  };
}

async function exportPiConductorTranscript(input: {
  repoRoot: string;
  resumeStore: SessionResumeStore;
  conductorAgentId: string;
  outputDirectory: string;
  files: SessionBundleFile[];
  sources: SessionBundleSource[];
  warnings: string[];
}): Promise<void> {
  const cwd = input.resumeStore.conductorCwd ?? input.resumeStore.repoRoot;
  let location: ReturnType<typeof findPiConductorSessionFile>;
  try {
    location = findPiConductorSessionFile({
      conductorAgentId: input.conductorAgentId,
      cwd,
      repoRoot: input.repoRoot,
      issueUrl: input.resumeStore.issueUrl,
    });
  } catch {
    location = undefined;
  }
  if (!location) {
    const reason = 'Pi transcript を保存先から解決できませんでした。';
    input.sources.push({
      id: 'conductor.piTranscript',
      status: 'unavailable',
      sourcePaths: [],
      bundlePaths: [],
      reason,
    });
    input.warnings.push(reason);
    return;
  }

  await copyRawSource({
    id: 'conductor.piTranscript',
    sourcePath: location.sessionFile,
    bundlePath: 'conductor/pi-transcript.jsonl',
    outputDirectory: input.outputDirectory,
    raceSensitive: true,
    files: input.files,
    sources: input.sources,
    warnings: input.warnings,
  });
}

async function exportCursorConductorRuns(input: {
  conductorAgentId: string;
  cwd: string;
  outputDirectory: string;
  files: SessionBundleFile[];
  sources: SessionBundleSource[];
  warnings: string[];
}): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof readCursorConductorRunSnapshots>>;
  try {
    snapshot = await readCursorConductorRunSnapshots({
      conductorAgentId: input.conductorAgentId,
      cwd: input.cwd,
    });
  } catch {
    snapshot = {
      status: 'unavailable',
      runs: [],
      warnings: ['Cursor local run snapshot を取得できませんでした。'],
    };
  }
  const path = 'conductor/cursor-runs.json';
  const file = await writeJsonPayload({
    outputDirectory: input.outputDirectory,
    path,
    value: snapshot,
  });
  input.files.push(file);
  input.sources.push({
    id: 'conductor.cursorRuns',
    status: snapshot.status,
    sourcePaths: [],
    bundlePaths: [path],
    ...(snapshot.status === 'unavailable'
      ? { reason: 'Cursor SDK から保存 run を取得できませんでした。' }
      : {}),
  });
  input.warnings.push(...snapshot.warnings);
}

async function exportSnapshotFile(input: {
  id: string;
  candidates: string[];
  outputDirectory: string;
  bundlePath: string;
  files: SessionBundleFile[];
  sources: SessionBundleSource[];
  warnings: string[];
}): Promise<void> {
  const located = await locateFirstRegularFile(input.candidates);
  input.warnings.push(...located.warnings);
  if (!located.path) {
    const reason = located.reason ?? '保存ファイルが見つかりません。';
    input.sources.push({
      id: input.id,
      status: 'unavailable',
      sourcePaths: input.candidates,
      bundlePaths: [],
      reason,
    });
    input.warnings.push(`${input.id}: ${reason}`);
    return;
  }
  await copyRawSource({
    id: input.id,
    sourcePath: located.path,
    bundlePath: input.bundlePath,
    outputDirectory: input.outputDirectory,
    files: input.files,
    sources: input.sources,
    warnings: input.warnings,
  });
}

async function exportToolCallHistory(input: {
  paths: EnsemblePaths;
  conductorAgentId: string;
  include: boolean;
  outputDirectory: string;
  files: SessionBundleFile[];
  sources: SessionBundleSource[];
  warnings: string[];
}): Promise<void> {
  if (!input.include) {
    input.sources.push({
      id: 'harness.toolCallSnapshots',
      status: 'not-requested',
      sourcePaths: [],
      bundlePaths: [],
    });
    return;
  }
  await exportSnapshotFile({
    id: 'harness.toolCallSnapshots',
    candidates: [
      input.paths.toolCallHistoryPath(input.conductorAgentId),
      input.paths.legacyToolCallHistoryPath(input.conductorAgentId),
    ],
    outputDirectory: input.outputDirectory,
    bundlePath: 'harness/session.tool-calls',
    files: input.files,
    sources: input.sources,
    warnings: input.warnings,
  });
}

async function exportOptionalInput(input: {
  id: string;
  sourcePath?: string;
  bundlePath: string;
  outputDirectory: string;
  files: SessionBundleFile[];
  sources: SessionBundleSource[];
  warnings: string[];
}): Promise<void> {
  if (input.sourcePath === undefined) {
    input.sources.push({
      id: input.id,
      status: 'not-requested',
      sourcePaths: [],
      bundlePaths: [],
    });
    return;
  }
  const sourcePath = resolve(input.sourcePath);
  await copyRawSource({
    id: input.id,
    sourcePath,
    bundlePath: input.bundlePath,
    outputDirectory: input.outputDirectory,
    files: input.files,
    sources: input.sources,
    warnings: input.warnings,
  });
}

async function copyRawSource(input: {
  id: string;
  sourcePath: string;
  bundlePath: string;
  outputDirectory: string;
  required?: boolean;
  raceSensitive?: boolean;
  files: SessionBundleFile[];
  sources: SessionBundleSource[];
  warnings: string[];
}): Promise<CopyResult | undefined> {
  let copied: CopyResult;
  try {
    copied = await copyRegularFile(
      input.sourcePath,
      bundleFilePath(input.outputDirectory, input.bundlePath),
    );
  } catch (error) {
    const reason = sourceCopyFailureReason(error);
    if (input.required) {
      throw new Error(
        `Required SessionResumeStore copy failed: ${reason}`,
      );
    }
    input.sources.push({
      id: input.id,
      status: 'unavailable',
      sourcePaths: [input.sourcePath],
      bundlePaths: [],
      reason,
    });
    input.warnings.push(`${input.id}: ${reason}`);
    return undefined;
  }

  input.files.push({
    path: input.bundlePath,
    kind: 'raw',
    sizeBytes: copied.sizeBytes,
    sha256: copied.sha256,
    sourcePaths: [input.sourcePath],
  });
  input.sources.push({
    id: input.id,
    status: copied.sourceChangedDuringCopy ? 'partial' : 'copied',
    sourcePaths: [input.sourcePath],
    bundlePaths: [input.bundlePath],
    ...(copied.sourceChangedDuringCopy
      ? { reason: 'source changed while the copy was in progress' }
      : {}),
  });
  if (copied.sourceChangedDuringCopy) {
    input.warnings.push(
      `${input.id}: コピー中に source が更新されたため、内容は best-effort snapshot です。`,
    );
  } else if (input.raceSensitive) {
    // Running Pi sessions may append after this check; this marks the source as
    // a live transcript even when no concurrent write was observed this time.
    const sourceStatus = await lstat(input.sourcePath).catch(() => undefined);
    if (sourceStatus && !sourceStatus.isFile()) {
      input.warnings.push(
        `${input.id}: コピー後に source path が file ではなくなりました。`,
      );
    }
  }
  return copied;
}

async function locateFirstRegularFile(
  candidates: readonly string[],
): Promise<SourceCandidateResult> {
  const warnings: string[] = [];
  for (const candidate of candidates) {
    let sourceInfo;
    try {
      sourceInfo = await lstat(candidate);
    } catch (error) {
      if (isEnoent(error)) continue;
      return {
        warnings,
        reason: '保存ファイルを確認できません。',
      };
    }
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
      warnings.push(
        `安全のため file 以外の source を読み飛ばしました: ${candidate}`,
      );
      continue;
    }
    return { path: candidate, warnings };
  }
  return {
    warnings,
    reason:
      warnings.length > 0
        ? '安全にコピーできる保存ファイルが見つかりません。'
        : '保存ファイルが見つかりません。',
  };
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
): Promise<CopyResult> {
  let before;
  try {
    before = await lstat(sourcePath);
  } catch (error) {
    if (isEnoent(error)) throw new SessionBundleSourceError('missing');
    throw new SessionBundleSourceError('unavailable');
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new SessionBundleSourceError('unsafe');
  }

  let sourceHandle;
  let destinationHandle;
  let destinationCreated = false;
  try {
    const noFollow =
      process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollow);
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new SessionBundleSourceError('unsafe');
    }

    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(destinationPath), 0o700);
    destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    destinationCreated = true;
    await destinationHandle.chmod(0o600);

    const hash = createHash('sha256');
    let sizeBytes = 0;
    const digestTransform = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, encoding);
        hash.update(bytes);
        sizeBytes += bytes.byteLength;
        callback(null, bytes);
      },
    });
    await pipeline(
      sourceHandle.createReadStream(),
      digestTransform,
      destinationHandle.createWriteStream(),
    );
    const pathAfter = await lstat(sourcePath).catch(() => undefined);
    const sourceChangedDuringCopy =
      pathAfter === undefined ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFile(opened, pathAfter) ||
      statChanged(opened, pathAfter);

    return {
      sizeBytes,
      sha256: hash.digest('hex'),
      sourceChangedDuringCopy,
    };
  } catch (error) {
    if (destinationCreated) {
      await unlink(destinationPath).catch(() => {});
    }
    if (error instanceof SessionBundleSourceError) throw error;
    if (isEnoent(error)) throw new SessionBundleSourceError('missing');
    if (isUnsafeSourceError(error)) {
      throw new SessionBundleSourceError('unsafe');
    }
    throw new SessionBundleSourceError('unavailable');
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }
}

async function writeJsonPayload(input: {
  outputDirectory: string;
  path: string;
  value: unknown;
  sourcePaths?: string[];
}): Promise<SessionBundleFile> {
  const contents = Buffer.from(`${JSON.stringify(input.value, null, 2)}\n`);
  const outputPath = bundleFilePath(input.outputDirectory, input.path);
  await writeBundleJsonFile(outputPath, contents);
  return {
    path: input.path,
    kind: 'json',
    sizeBytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
    sourcePaths: input.sourcePaths ?? [],
  };
}

async function writeBundleJsonFile(
  path: string,
  value: unknown | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(
      Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createNewBundleDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Output directory already exists: ${path}`);
    }
    throw error;
  }
  try {
    await chmod(path, 0o700);
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function bundleFilePath(outputDirectory: string, relativePath: string): string {
  const root = resolve(outputDirectory);
  const destination = resolve(root, ...relativePath.split('/'));
  if (!destination.startsWith(`${root}${sep}`)) {
    throw new Error('Bundle file path escapes the output directory.');
  }
  return destination;
}

function workerBundlePath(workerName: string, index: number): string {
  const prefix =
    workerName
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'worker';
  const suffix = createHash('sha256').update(workerName).digest('hex').slice(0, 12);
  return `workers/${String(index + 1).padStart(2, '0')}-${prefix}-${suffix}.json`;
}

function sourceStatusFromWorkerHistory(
  history: WorkerSessionHistoryResult,
): SessionBundleSourceStatus {
  if (history.status === 'supported') return 'available';
  return history.status;
}

function sourceCopyFailureReason(error: unknown): string {
  if (error instanceof SessionBundleSourceError) {
    switch (error.kind) {
      case 'missing':
        return 'source file が見つかりません。';
      case 'unsafe':
        return 'symlink または通常 file 以外の source はコピーしません。';
      case 'unavailable':
        return 'source file を安全に読み取れませんでした。';
    }
  }
  return 'source file をコピーできませんでした。';
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function statChanged(
  left: { size: number; mtimeMs: number; ctimeMs: number },
  right: { size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return (
    left.size !== right.size ||
    left.mtimeMs !== right.mtimeMs ||
    left.ctimeMs !== right.ctimeMs
  );
}

function isUnsafeSourceError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'EISDIR')
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty.`);
  return normalized;
}
