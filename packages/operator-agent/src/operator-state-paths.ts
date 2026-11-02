import {
  listLocatedSessionResumeStores,
  resolveEnsemblePaths,
  type SessionResumeStoreLocation,
} from '@agents-ensemble/core/operator-runtime';

export type OperatorRepositoryStateFile = 'session' | 'watch';

export interface OperatorRepositoryStatePaths {
  location: 'canonical-slug' | 'user-path-hash';
  issueUrl?: string;
  targetPath: string;
  readPaths: string[];
  allPaths: string[];
}

export async function resolveOperatorRepositoryStatePaths(
  repoRoot: string,
  file: OperatorRepositoryStateFile,
): Promise<OperatorRepositoryStatePaths> {
  const paths = resolveEnsemblePaths({ repoRoot });
  const stores = await listLocatedSessionResumeStores(repoRoot);
  const canonicalStores = stores.filter(
    ({ location }) => location === 'canonical-slug',
  );
  const canonicalStoresByRoot = new Map<string, string>();
  const canonicalPaths = new Set<string>();
  for (const { resumeStore } of canonicalStores) {
    try {
      const canonicalRoot = paths.canonicalRepoSessionsDir(
        resumeStore.issueUrl,
      );
      canonicalStoresByRoot.set(canonicalRoot, resumeStore.issueUrl);
      canonicalPaths.add(
        file === 'session'
          ? paths.canonicalOperatorAgentSessionPath(resumeStore.issueUrl)
          : paths.canonicalOperatorWatchStatePath(resumeStore.issueUrl),
      );
    } catch {
      // Invalid or legacy issue URLs do not define a slug-keyed state path.
    }
  }
  const allStoresAreCanonical =
    stores.length > 0 &&
    stores.every(({ location }) => location === 'canonical-slug');
  const useCanonicalSlug =
    allStoresAreCanonical && canonicalStoresByRoot.size === 1;
  const issueUrl = useCanonicalSlug
    ? [...canonicalStoresByRoot.values()][0]
    : undefined;
  const location: 'canonical-slug' | 'user-path-hash' = useCanonicalSlug
    ? 'canonical-slug'
    : 'user-path-hash';
  const statePath = (selectedLocation: SessionResumeStoreLocation) => {
    if (file === 'session') {
      return selectedLocation === 'canonical-slug' && issueUrl
        ? paths.canonicalOperatorAgentSessionPath(issueUrl)
        : paths.operatorAgentSessionPath;
    }
    return selectedLocation === 'canonical-slug' && issueUrl
      ? paths.canonicalOperatorWatchStatePath(issueUrl)
      : paths.operatorWatchStatePath;
  };
  const targetPath = statePath(location);
  const hashPath = statePath('user-path-hash');
  const legacyPath =
    file === 'session'
      ? paths.legacyOperatorAgentSessionPath
      : paths.legacyOperatorWatchStatePath;
  return {
    location,
    ...(issueUrl ? { issueUrl } : {}),
    targetPath,
    readPaths:
      location === 'canonical-slug'
        ? [targetPath, hashPath, legacyPath]
        : [hashPath, legacyPath],
    allPaths: [
      ...new Set([targetPath, hashPath, legacyPath, ...canonicalPaths]),
    ],
  };
}

export function operatorRepositoryStatePath(
  repoRoot: string,
  file: OperatorRepositoryStateFile,
  options: {
    location?: 'canonical-slug' | 'user-path-hash';
    issueUrl?: string;
  } = {},
): string {
  const paths = resolveEnsemblePaths({ repoRoot });
  if (options.location === 'canonical-slug' && options.issueUrl) {
    return file === 'session'
      ? paths.canonicalOperatorAgentSessionPath(options.issueUrl)
      : paths.canonicalOperatorWatchStatePath(options.issueUrl);
  }
  return file === 'session'
    ? paths.operatorAgentSessionPath
    : paths.operatorWatchStatePath;
}
