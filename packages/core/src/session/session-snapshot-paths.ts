import {
  legacyOpenQuestionsStorePath,
  openQuestionsStorePath,
} from './open-questions-store.js';
import {
  legacySessionStateStorePath,
  sessionStateStorePath,
} from './session-state-store.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type {
  LocatedSessionResumeStore,
  SessionResumeStoreLocation,
} from './session-resume-store.js';

export type SessionSnapshotKind = 'open-questions' | 'session-state';

/** Return slug-first snapshot paths with local and saved-root legacy fallbacks. */
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
  const legacyPath = (root: string) =>
    kind === 'open-questions'
      ? legacyOpenQuestionsStorePath({
          repoRoot: root,
          conductorAgentId: resumeStore.conductorAgentId,
        })
      : legacySessionStateStorePath({
          repoRoot: root,
          conductorAgentId: resumeStore.conductorAgentId,
        });

  const savedRepoRoot = resumeStore.repoRoot;
  const roots = [...new Set([repoRoot, savedRepoRoot])];
  const currentRoot = roots[0]!;
  const paths = [
    userPath(currentRoot!, 'canonical-slug'),
    ...roots.map((root) => userPath(root, 'user-path-hash')),
    ...roots.map(legacyPath),
  ];
  return [...new Set(paths)];
}

/**
 * Return user-layer snapshot paths for a repository-independent operator.
 *
 * The saved repoRoot is used only to derive that session's old path-hash
 * fallback. Project-local `.ensemble` paths are deliberately excluded.
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
  const hashPath =
    kind === 'open-questions'
      ? paths.openQuestionsPath(input.conductorAgentId)
      : paths.sessionStatePath(input.conductorAgentId);
  return [...new Set([canonicalPath, hashPath])];
}
