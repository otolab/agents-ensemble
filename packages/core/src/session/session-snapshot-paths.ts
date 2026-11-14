import {
  legacyOpenQuestionsStorePath,
  openQuestionsStorePath,
} from './open-questions-store.js';
import {
  legacySessionStateStorePath,
  sessionStateStorePath,
} from './session-state-store.js';
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
