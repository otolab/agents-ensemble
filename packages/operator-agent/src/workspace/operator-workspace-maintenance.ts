import { lstat, unlink } from 'node:fs/promises';
import { resolveUserEnsembleRoot } from '@agents-ensemble/core/operator-runtime';
import {
  operatorAgentProfileDirectory,
  resolveOperatorAgentConfigScope,
  validateProfileName,
} from '../config/operator-agent-config.js';
import { withOperatorWorkspaceLock } from './operator-workspace-lock.js';
import { readMoveStatus, resolveOperatorWorkspaceRoot, workspaceMoveJournalPath } from './operator-workspace-tools.js';

/** Hold the workspace lock while the operator inspects and preserves interrupted data. */
export async function maintainOperatorWorkspace(
  profile: string,
  inspect: (status: Record<string, unknown>, journal: string) => Promise<boolean>,
  options: { configPath?: string } = {},
): Promise<void> {
  validateProfileName(profile);
  const userRoot = resolveUserEnsembleRoot();
  const configScope = await resolveOperatorAgentConfigScope(
    userRoot,
    options.configPath,
  );
  const root = await resolveOperatorWorkspaceRoot(
    operatorAgentProfileDirectory(userRoot, profile, configScope),
  );
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
