import { isEnoentError as isEnoent } from './operator-utils.js';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';
import { validateProfileName } from '../config/operator-agent-config.js';

export function operatorWatchStatePath(
  userEnsembleRoot: string,
  profile: string,
  issueUrl: string,
): string {
  validateProfileName(profile);
  const paths = resolveEnsemblePaths({
    repoRoot: userEnsembleRoot,
    userEnsembleRoot,
  });
  return join(
    userEnsembleRoot,
    'operator-agents',
    profile,
    'watch',
    relative(
      paths.sessionsRoot,
      paths.canonicalRepoSessionsDir(issueUrl),
    ),
    'watch-state.json',
  );
}

export async function listOperatorWatchStatePaths(
  userEnsembleRoot: string,
  profile: string,
): Promise<string[]> {
  validateProfileName(profile);
  const root = join(userEnsembleRoot, 'operator-agents', profile, 'watch');
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === 'watch-state.json') {
        paths.push(path);
      }
    }
  };
  await visit(root);
  return paths.sort();
}
