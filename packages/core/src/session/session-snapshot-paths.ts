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

/** Return snapshot paths in the same precedence used when resuming a session. */
export function sessionSnapshotPaths(
  repoRoot: string,
  located: LocatedSessionResumeStore,
  kind: SessionSnapshotKind,
): string[] {
  const { resumeStore, location } = located;
  const userPath = (
    selectedLocation: SessionResumeStoreLocation,
  ): string => {
    const input = {
      repoRoot,
      conductorAgentId: resumeStore.conductorAgentId,
      issueUrl: resumeStore.issueUrl,
      location: selectedLocation,
    };
    return kind === 'open-questions'
      ? openQuestionsStorePath(input)
      : sessionStateStorePath(input);
  };
  const legacyPath =
    kind === 'open-questions'
      ? legacyOpenQuestionsStorePath({
          repoRoot,
          conductorAgentId: resumeStore.conductorAgentId,
        })
      : legacySessionStateStorePath({
          repoRoot,
          conductorAgentId: resumeStore.conductorAgentId,
        });

  if (location === 'canonical-slug') {
    return [
      userPath('canonical-slug'),
      userPath('user-path-hash'),
      legacyPath,
    ];
  }
  if (location === 'user-path-hash') {
    return [userPath('user-path-hash'), legacyPath];
  }
  return [legacyPath];
}
