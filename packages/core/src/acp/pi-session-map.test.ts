import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateLegacyPiAcpSessionMap,
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
});
