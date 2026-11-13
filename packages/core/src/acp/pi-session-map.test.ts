import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateLegacyPiAcpSessionMap,
  preparePiAcpSessionStorage,
  resolvePiAcpSessionMapPaths,
} from './pi-session-map.js';

describe('Pi ACP session map paths', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('copies the previous builtin map to upstream pi-acp home storage', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const paths = resolvePiAcpSessionMapPaths(join(tempRoot, 'worker'));
    const legacyContent = '{"version":1,"sessions":{"old-session":{}}}\n';
    await mkdir(dirname(paths.legacyPath), { recursive: true });
    await writeFile(paths.legacyPath, legacyContent);

    expect(migrateLegacyPiAcpSessionMap(paths)).toBe(true);
    await expect(readFile(paths.upstreamPath, 'utf8')).resolves.toBe(
      legacyContent,
    );
    await expect(readFile(paths.legacyPath, 'utf8')).resolves.toBe(
      legacyContent,
    );
  });

  it('keeps an existing upstream map authoritative', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const paths = resolvePiAcpSessionMapPaths(join(tempRoot, 'worker'));
    const legacyContent = '{"version":1,"sessions":{"legacy":{}}}\n';
    const upstreamContent = '{"version":1,"sessions":{"current":{}}}\n';
    await Promise.all([
      mkdir(dirname(paths.legacyPath), { recursive: true }),
      mkdir(dirname(paths.upstreamPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(paths.legacyPath, legacyContent),
      writeFile(paths.upstreamPath, upstreamContent),
    ]);

    expect(migrateLegacyPiAcpSessionMap(paths)).toBe(false);
    await expect(readFile(paths.upstreamPath, 'utf8')).resolves.toBe(
      upstreamContent,
    );
  });

  it('does nothing when no legacy map exists', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const paths = resolvePiAcpSessionMapPaths(join(tempRoot, 'worker'));

    expect(migrateLegacyPiAcpSessionMap(paths)).toBe(false);
  });

  it('copies the old shared map for each Issue while preserving old session paths', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const workerStorageRoot = join(tempRoot, 'worker-root');
    const legacyWorkerHome = join(workerStorageRoot, 'implementer-old');
    const issueOneHome = join(
      workerStorageRoot,
      'issue-1',
      'implementer-new',
    );
    const issueTwoHome = join(
      workerStorageRoot,
      'issue-2',
      'implementer-new',
    );
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const issueOnePaths = resolvePiAcpSessionMapPaths(
      issueOneHome,
      legacyWorkerHome,
    );
    const issueTwoPaths = resolvePiAcpSessionMapPaths(
      issueTwoHome,
      legacyWorkerHome,
    );
    const transcriptPath = join(
      legacyWorkerHome,
      'sessions',
      'existing-session.jsonl',
    );
    const mapContents =
      '{"version":1,"sessions":{"existing-session":{"sessionId":"existing-session","cwd":"/tmp/issue-1","sessionFile":"' +
      transcriptPath +
      '"}}}\n';
    await Promise.all([
      mkdir(dirname(legacyPaths.upstreamPath), {
        recursive: true,
        mode: 0o755,
      }),
      mkdir(dirname(transcriptPath), { recursive: true, mode: 0o755 }),
    ]);
    await Promise.all([
      writeFile(legacyPaths.upstreamPath, mapContents, { mode: 0o644 }),
      writeFile(transcriptPath, 'existing transcript', { mode: 0o644 }),
    ]);

    preparePiAcpSessionStorage({
      workerStorageRoot,
      workerHome: issueOneHome,
      sessionsDir: join(issueOneHome, 'sessions'),
      legacyWorkerHome,
      mapPaths: issueOnePaths,
    });
    preparePiAcpSessionStorage({
      workerStorageRoot,
      workerHome: issueTwoHome,
      sessionsDir: join(issueTwoHome, 'sessions'),
      legacyWorkerHome,
      mapPaths: issueTwoPaths,
    });

    await expect(readFile(issueOnePaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(issueTwoPaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(legacyPaths.upstreamPath, 'utf8')).resolves.toBe(
      mapContents,
    );
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe(
      'existing transcript',
    );

    if (process.platform !== 'win32') {
      for (const directory of [
        workerStorageRoot,
        legacyWorkerHome,
        join(legacyWorkerHome, 'sessions'),
        issueOneHome,
        join(issueOneHome, 'sessions'),
        issueTwoHome,
        join(issueTwoHome, 'sessions'),
        dirname(issueOnePaths.upstreamPath),
        dirname(issueTwoPaths.upstreamPath),
      ]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
      for (const file of [
        legacyPaths.upstreamPath,
        issueOnePaths.upstreamPath,
        issueTwoPaths.upstreamPath,
        transcriptPath,
      ]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it('does not replace a new Issue map with the legacy shared map', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-map-'));
    const workerStorageRoot = join(tempRoot, 'worker-root');
    const legacyWorkerHome = join(workerStorageRoot, 'legacy-worker');
    const workerHome = join(workerStorageRoot, 'issue-7', 'worker');
    const legacyPaths = resolvePiAcpSessionMapPaths(legacyWorkerHome);
    const issuePaths = resolvePiAcpSessionMapPaths(
      workerHome,
      legacyWorkerHome,
    );
    const oldMap = '{"version":1,"sessions":{"old":{}}}\n';
    const currentMap = '{"version":1,"sessions":{"new":{}}}\n';
    await Promise.all([
      mkdir(dirname(legacyPaths.upstreamPath), { recursive: true }),
      mkdir(dirname(issuePaths.upstreamPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacyPaths.upstreamPath, oldMap),
      writeFile(issuePaths.upstreamPath, currentMap),
    ]);

    expect(migrateLegacyPiAcpSessionMap(issuePaths)).toBe(false);
    await expect(readFile(issuePaths.upstreamPath, 'utf8')).resolves.toBe(
      currentMap,
    );
  });
});
