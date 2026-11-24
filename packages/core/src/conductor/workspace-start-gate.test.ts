import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeWorkspaceAnchor } from '../workspace-run/slug-key.js';
import { runConductorSession, type RunConductorSessionOptions } from './conductor-session.js';

it('rejects a stale workspace identity before starting a conductor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-stale-workspace-'));
  vi.stubEnv('ENSEMBLE_USER_ROOT', join(root, 'user'));
  try {
    await writeWorkspaceAnchor(root, 'new');
    await expect(runConductorSession({
      issueUrl: 'workspace://old',
      repoRoot: root,
      conductorCwd: root,
    } as RunConductorSessionOptions)).rejects.toThrow('Workspace anchor changed to "new"');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
