import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type {
  LocatedSessionResumeStore,
  SessionResumeStoreLocation,
} from './session-resume-store.js';
import { sessionSnapshotPaths } from './session-snapshot-paths.js';

const repoRoot = '/repo';
const userRoot = '/home/test/.ensemble';
const issueUrl = 'https://github.com/owner/repository/issues/1';

describe('sessionSnapshotPaths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    'canonical-slug',
    'user-path-hash',
    'project-legacy',
  ] as const)(
    'uses slug-first fallback precedence for $location snapshots',
    (location) => {
      vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
      const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot: userRoot });
      const located: LocatedSessionResumeStore = {
        resumeStore: {
          version: 1,
          conductorAgentId: 'agent-1',
          issueUrl,
          repoRoot,
          profile: { workers: [] },
          openQuestions: [],
          sequence: 0,
          workers: {},
          updatedAt: 0,
        },
        path: paths.sessionResumeStorePath('agent-1'),
        location: location as SessionResumeStoreLocation,
      };

      for (const kind of ['open-questions', 'session-state'] as const) {
        const expected = [
          'canonical-slug',
          'user-path-hash',
          'project-legacy',
        ].map((selectedLocation) => {
          if (selectedLocation === 'project-legacy') {
            return kind === 'open-questions'
              ? paths.legacyOpenQuestionsPath('agent-1')
              : paths.legacySessionStatePath('agent-1');
          }
          if (selectedLocation === 'canonical-slug') {
            return kind === 'open-questions'
              ? paths.canonicalOpenQuestionsPath(issueUrl, 'agent-1')
              : paths.canonicalSessionStatePath(issueUrl, 'agent-1');
          }
          return kind === 'open-questions'
            ? paths.openQuestionsPath('agent-1')
            : paths.sessionStatePath('agent-1');
        });

        expect(sessionSnapshotPaths(repoRoot, located, kind)).toEqual(expected);
      }
    },
  );

  it('keeps canonical slug first and checks both clone hash fallbacks', () => {
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    const currentPaths = resolveEnsemblePaths({
      repoRoot,
      userEnsembleRoot: userRoot,
    });
    const savedRepoRoot = '/origin/repository';
    const savedPaths = resolveEnsemblePaths({
      repoRoot: savedRepoRoot,
      userEnsembleRoot: userRoot,
    });
    const located: LocatedSessionResumeStore = {
      resumeStore: {
        version: 1,
        conductorAgentId: 'agent-1',
        issueUrl,
        repoRoot: savedRepoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: 0,
      },
      path: currentPaths.canonicalSessionResumeStorePath(issueUrl, 'agent-1'),
      location: 'canonical-slug',
    };

    expect(
      sessionSnapshotPaths(repoRoot, located, 'session-state'),
    ).toEqual([
      currentPaths.canonicalSessionStatePath(issueUrl, 'agent-1'),
      currentPaths.sessionStatePath('agent-1'),
      savedPaths.sessionStatePath('agent-1'),
      currentPaths.legacySessionStatePath('agent-1'),
      savedPaths.legacySessionStatePath('agent-1'),
    ]);
  });
});
