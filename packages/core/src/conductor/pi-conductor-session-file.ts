import { SessionManager } from '@earendil-works/pi-coding-agent';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export interface PiConductorSessionFile {
  sessionFile: string;
  sessionDir: string;
}

/** Find the Pi transcript in Issue-scoped canonical storage. */
export function findPiConductorSessionFile(input: {
  conductorAgentId: string;
  cwd: string;
  repoRoot?: string;
  issueUrl?: string;
  resumeCwds?: readonly string[];
}): PiConductorSessionFile | undefined {
  const paths = resolveEnsemblePaths({
    repoRoot: input.repoRoot ?? input.cwd,
  });
  const candidateCwds = [...new Set([input.cwd, ...(input.resumeCwds ?? [])])];
  const sessionDirs = [
    ...(input.issueUrl ? [paths.canonicalPiSessionsDir(input.issueUrl)] : []),
  ];
  for (const sessionDir of new Set(sessionDirs)) {
    for (const cwd of candidateCwds) {
      const sessionFile = SessionManager.findById(
        cwd,
        input.conductorAgentId,
        sessionDir,
      );
      if (sessionFile) return { sessionFile, sessionDir };
    }
  }
  return undefined;
}
