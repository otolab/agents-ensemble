import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attachWorker } from '../../src/dispatch/attach-worker.js';
import { loadProfile } from '../../src/profile/load-profile.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

describe('team profile workspace validation integration', () => {
  it('rejects unusable profile at loadProfile before attach', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-profile-load-reject-'));
    const profileDir = join(repoRoot, '.ensemble', 'teams', 'broken');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers:
  - name: librarian
    kind: librarian
    workspace: missing-docs
`,
    );

    await expect(
      loadProfile({
        profile: 'broken',
        cwd: repoRoot,
      }),
    ).rejects.toThrow(/Cannot use team profile "broken": worker "librarian" workspace does not exist/);
  });

  it('still rejects missing workspace at attach when validation is bypassed', async () => {
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);

    await expect(
      attachWorker({
        issueUrl: TEST_ISSUE.url,
        name: 'librarian',
        kind: 'ping',
        sessionState: { workers: [], kinds: [] },
        worktree: TEST_WORKTREE,
        resolvedWorkspacePath: join('/tmp', 'missing-workspace-for-attach'),
        connectAcp: async () => createInProcessAcpBridge(),
      }),
    ).rejects.toThrow(/does not exist/);

    vi.restoreAllMocks();
  });
});
