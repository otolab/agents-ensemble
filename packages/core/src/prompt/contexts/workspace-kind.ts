import type { EnsembleSessionState } from '../../profile/types.js';

export interface WorkspaceEnsembleContext extends EnsembleSessionState {
  kind: string;
  workspaceSlugKey: string;
}

export function workspaceEnsembleContext(
  kind: string,
  workspaceSlugKey: string,
  session: EnsembleSessionState,
): WorkspaceEnsembleContext {
  return {
    kind,
    workspaceSlugKey,
    workers: session.workers,
    kinds: session.kinds,
  };
}