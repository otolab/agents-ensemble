import { join } from 'node:path';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { parseWorkspaceSessionUrl } from '../workspace-run/session-url.js';

/** Resolve the canonical transcript directory for either session identity. */
export function piConductorSessionDir(input: {
  cwd: string;
  issueUrl: string;
}): string {
  const paths = resolveEnsemblePaths({ repoRoot: input.cwd });
  const workspace = parseWorkspaceSessionUrl(input.issueUrl);
  return workspace
    ? join(paths.workspaceSlugDir(workspace.slugKey), 'pi')
    : paths.canonicalPiSessionsDir(input.issueUrl);
}
