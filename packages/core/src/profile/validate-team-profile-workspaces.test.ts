import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertTeamProfileWorkspacesAvailable,
  formatTeamProfileActivationError,
  validateTeamProfileWorkspaces,
} from './validate-team-profile-workspaces.js';

describe('validateTeamProfileWorkspaces', () => {
  let repoRoot = '';

  afterEach(() => {
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = '';
    }
  });

  it('returns available when no worker has workspace', () => {
    const result = validateTeamProfileWorkspaces(
      {
        workers: [
          { name: 'implementer', kind: 'implementer' },
          { name: 'reviewer', kind: 'reviewer' },
        ],
      },
      '/profile',
      '/repo',
    );

    expect(result).toEqual({ availability: 'available' });
  });

  it('returns available when all workspaces exist', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-validate-ws-'));
    const docsDir = join(repoRoot, 'docs-repo');
    mkdirSync(docsDir, { recursive: true });

    const result = validateTeamProfileWorkspaces(
      {
        workers: [
          { name: 'implementer', kind: 'implementer' },
          {
            name: 'librarian',
            kind: 'librarian',
            workspace: 'docs-repo',
          },
        ],
      },
      join(repoRoot, 'profiles', 'team'),
      repoRoot,
    );

    expect(result).toEqual({ availability: 'available' });
  });

  it('returns unusable when a workspace is missing', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-validate-missing-'));

    const result = validateTeamProfileWorkspaces(
      {
        workers: [
          {
            name: 'librarian',
            kind: 'librarian',
            workspace: 'missing-workspace',
          },
        ],
      },
      join(repoRoot, 'profiles', 'team'),
      repoRoot,
    );

    expect(result.availability).toBe('unusable');
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]).toMatchObject({
      worker: 'librarian',
      kind: 'librarian',
      reason: 'missing',
    });
    expect(result.issues?.[0]?.workspace).toBe(join(repoRoot, 'missing-workspace'));
  });

  it('returns unusable when workspace is a file', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-validate-file-'));
    const filePath = join(repoRoot, 'not-dir');
    writeFileSync(filePath, 'x');

    const result = validateTeamProfileWorkspaces(
      {
        workers: [
          {
            name: 'librarian',
            kind: 'librarian',
            workspace: 'not-dir',
          },
        ],
      },
      repoRoot,
      repoRoot,
    );

    expect(result.availability).toBe('unusable');
    expect(result.issues?.[0]).toMatchObject({
      worker: 'librarian',
      reason: 'not_directory',
    });
  });
});

describe('assertTeamProfileWorkspacesAvailable', () => {
  it('throws with profile ref in message', () => {
    expect(() =>
      assertTeamProfileWorkspacesAvailable(
        {
          workers: [
            {
              name: 'librarian',
              kind: 'librarian',
              workspace: '/no/such/workspace',
            },
          ],
        },
        '/profile',
        '/repo',
        'with-librarian',
      ),
    ).toThrow(
      'Cannot use team profile "with-librarian": worker "librarian" workspace does not exist: /no/such/workspace',
    );
  });
});

describe('formatTeamProfileActivationError', () => {
  it('formats activation error from validation issue', () => {
    const message = formatTeamProfileActivationError('my-team', {
      worker: 'librarian',
      kind: 'librarian',
      workspace: '/missing',
      reason: 'missing',
      message: 'Worker "librarian" workspace does not exist: /missing',
    });

    expect(message).toBe(
      'Cannot use team profile "my-team": worker "librarian" workspace does not exist: /missing',
    );
  });
});
