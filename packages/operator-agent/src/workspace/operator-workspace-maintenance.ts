import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveUserEnsembleRoot } from '@agents-ensemble/core/operator-runtime';
import { validateProfileName } from '../config/operator-agent-config.js';
import { withOperatorWorkspaceLock } from './operator-workspace-lock.js';
import { readMoveStatus, resolveOperatorWorkspaceRoot, workspaceMoveJournalPath } from './operator-workspace-tools.js';

/** Hold the workspace lock while the operator inspects and preserves interrupted data. */
export async function maintainOperatorWorkspace(
  profile: string,
  inspect: (status: Record<string, unknown>, journal: string) => Promise<boolean>,
): Promise<void> {
  validateProfileName(profile);
  const root = await resolveOperatorWorkspaceRoot(join(resolveUserEnsembleRoot(), 'operator-agents', profile));
  await withOperatorWorkspaceLock(root, async () => {
    const journal = workspaceMoveJournalPath(root);
    const before = await lstat(journal);
    if (!before.isFile()) throw new Error('The move journal is not a regular file.');
    const status = await readMoveStatus(root, journal);
    if (status.status === 'idle') throw new Error('The move journal disappeared.');
    if (!await inspect(status, journal)) return;
    const after = await lstat(journal);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('The move journal changed during inspection; it was not removed.');
    }
    await unlink(journal);
  });
}
