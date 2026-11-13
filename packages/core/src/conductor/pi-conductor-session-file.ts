import { SessionManager } from '@earendil-works/pi-coding-agent';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export interface PiConductorSessionFile {
  sessionFile: string;
  sessionDir: string;
}

/**
 * Find the Pi transcript using the same repo-root-first lookup used by
 * conductor provider history.
 */
export function findPiConductorSessionFile(input: {
  conductorAgentId: string;
  cwd: string;
  repoRoot?: string;
}): PiConductorSessionFile | undefined {
  const paths = resolveEnsemblePaths({
    repoRoot: input.repoRoot ?? input.cwd,
  });
  for (const sessionDir of new Set([
    paths.piSessionsDir,
    paths.legacyPiSessionsDirForCwd(input.cwd),
  ])) {
    const sessionFile = SessionManager.findById(
      input.cwd,
      input.conductorAgentId,
      sessionDir,
    );
    if (sessionFile) return { sessionFile, sessionDir };
  }
  return undefined;
}
