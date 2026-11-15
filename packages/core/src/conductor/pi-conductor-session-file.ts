import { SessionManager } from '@earendil-works/pi-coding-agent';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export interface PiConductorSessionFile {
  sessionFile: string;
  sessionDir: string;
}

/**
 * Find the Pi transcript in canonical slug storage before legacy locations.
 */
export function findPiConductorSessionFile(input: {
  conductorAgentId: string;
  cwd: string;
  repoRoot?: string;
  issueUrl?: string;
  fallbackRepoRoots?: readonly string[];
  fallbackCwds?: readonly string[];
}): PiConductorSessionFile | undefined {
  const paths = resolveEnsemblePaths({
    repoRoot: input.repoRoot ?? input.cwd,
  });
  const fallbackRepoHashDirs = (input.fallbackRepoRoots ?? []).map(
    (repoRoot) => resolveEnsemblePaths({ repoRoot }).piSessionsDir,
  );
  const fallbackCwds = [...new Set([input.cwd, ...(input.fallbackCwds ?? [])])];
  const sessionDirs = [
    ...(input.issueUrl ? [paths.canonicalPiSessionsDir(input.issueUrl)] : []),
    paths.piSessionsDir,
    ...fallbackRepoHashDirs,
  ];
  for (const sessionDir of new Set(sessionDirs)) {
    for (const cwd of fallbackCwds) {
      const sessionFile = SessionManager.findById(
        cwd,
        input.conductorAgentId,
        sessionDir,
      );
      if (sessionFile) return { sessionFile, sessionDir };
    }
  }
  for (const cwd of fallbackCwds) {
    const sessionDir = paths.legacyPiSessionsDirForCwd(cwd);
    const sessionFile = SessionManager.findById(
      cwd,
      input.conductorAgentId,
      sessionDir,
    );
    if (sessionFile) return { sessionFile, sessionDir };
  }
  return undefined;
}
