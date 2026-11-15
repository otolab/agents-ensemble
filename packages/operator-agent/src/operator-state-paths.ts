import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';
import { validateProfileName } from './operator-agent-config.js';

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

export async function legacyOperatorWatchStatePaths(
  userEnsembleRoot: string,
  issueUrl?: string,
): Promise<string[]> {
  const paths = resolveEnsemblePaths({
    repoRoot: userEnsembleRoot,
    userEnsembleRoot,
  });
  const legacyRoot = join(userEnsembleRoot, 'operator-agent');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(legacyRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const oldHashPaths = entries
    .filter(
      (entry) =>
        entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name),
    )
    .map((entry) => join(legacyRoot, entry.name, 'watch-state.json'));
  return [
    ...new Set([
      ...(issueUrl ? [paths.canonicalOperatorWatchStatePath(issueUrl)] : []),
      ...oldHashPaths,
    ]),
  ];
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

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
