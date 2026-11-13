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
}): PiConductorSessionFile | undefined {
  const paths = resolveEnsemblePaths({
    repoRoot: input.repoRoot ?? input.cwd,
  });
  for (const sessionDir of new Set([
    ...(input.issueUrl ? [paths.canonicalPiSessionsDir(input.issueUrl)] : []),
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
