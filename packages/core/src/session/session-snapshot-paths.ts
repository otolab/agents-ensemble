import { openQuestionsStorePath } from './open-questions-store.js';
import { sessionStateStorePath } from './session-state-store.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type {
  LocatedSessionResumeStore,
  SessionResumeStoreLocation,
} from './session-resume-store.js';

export type SessionSnapshotKind = 'open-questions' | 'session-state';

/** Return the Issue-scoped canonical path for a session snapshot. */
export function sessionSnapshotPaths(
  repoRoot: string,
  located: LocatedSessionResumeStore,
  kind: SessionSnapshotKind,
): string[] {
  const { resumeStore } = located;
  const userPath = (
    root: string,
    selectedLocation: SessionResumeStoreLocation,
  ): string => {
    const input = {
      repoRoot: root,
      conductorAgentId: resumeStore.conductorAgentId,
      issueUrl: resumeStore.issueUrl,
      location: selectedLocation,
    };
    return kind === 'open-questions'
      ? openQuestionsStorePath(input)
      : sessionStateStorePath(input);
  };
  return [userPath(repoRoot, 'canonical-slug')];
}

/**
 * Return user-layer snapshot paths for a repository-independent operator.
 *
 * Project-local `.ensemble` and path-hash locations are deliberately excluded.
 */
export function userSessionSnapshotPaths(
  userEnsembleRoot: string,
  located: LocatedSessionResumeStore,
  kind: SessionSnapshotKind,
): string[] {
  const { resumeStore } = located;
  const paths = resolveEnsemblePaths({
    repoRoot: resumeStore.repoRoot,
    userEnsembleRoot,
  });
  const input = {
    repoRoot: resumeStore.repoRoot,
    conductorAgentId: resumeStore.conductorAgentId,
    issueUrl: resumeStore.issueUrl,
  };
  const canonicalPath =
    kind === 'open-questions'
      ? paths.canonicalOpenQuestionsPath(
          input.issueUrl,
          input.conductorAgentId,
        )
      : paths.canonicalSessionStatePath(
          input.issueUrl,
          input.conductorAgentId,
        );
  return [canonicalPath];
}
