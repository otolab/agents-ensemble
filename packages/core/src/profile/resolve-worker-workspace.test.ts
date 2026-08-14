import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWorkerWorkspaceDirectory,
  resolveWorkerWorkspacePath,
  summarizeWorkspacePath,
} from './resolve-worker-workspace.js';

describe('resolveWorkerWorkspacePath', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolveWorkerWorkspacePath('/abs/docs', '/profile', '/repo')).toBe(
      '/abs/docs',
    );
  });

  it('resolves profile-relative paths', () => {
    expect(
      resolveWorkerWorkspacePath('../sibling', '/repo/profiles/implementer-and-reviewer', '/repo'),
    ).toBe('/repo/profiles/sibling');
  });

  it('resolves repo-root-relative paths', () => {
    expect(
      resolveWorkerWorkspacePath('docs-repo', '/repo/profiles/implementer-and-reviewer', '/repo'),
    ).toBe('/repo/docs-repo');
  });
});

describe('assertWorkerWorkspaceDirectory', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('accepts an existing directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'ensemble-ws-'));
    expect(() => assertWorkerWorkspaceDirectory(dir, 'librarian')).not.toThrow();
  });

  it('rejects missing paths', () => {
    expect(() =>
      assertWorkerWorkspaceDirectory('/no/such/workspace', 'librarian'),
    ).toThrow(/does not exist/);
  });

  it('rejects files', () => {
    dir = mkdtempSync(join(tmpdir(), 'ensemble-ws-'));
    const file = join(dir, 'not-dir');
    writeFileSync(file, 'x');
    expect(() => assertWorkerWorkspaceDirectory(file)).toThrow(/not a directory/);
  });
});

describe('summarizeWorkspacePath', () => {
  it('returns repo-relative path when under repo root', () => {
    expect(summarizeWorkspacePath('/repo/docs', '/repo')).toBe('docs');
  });

  it('returns absolute path when outside repo root', () => {
    expect(summarizeWorkspacePath('/other/docs', '/repo')).toBe('/other/docs');
  });
});
