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
    {
      location: 'canonical-slug',
      expectedLocations: ['canonical-slug', 'user-path-hash', 'project-legacy'],
    },
    {
      location: 'user-path-hash',
      expectedLocations: ['user-path-hash', 'project-legacy'],
    },
    {
      location: 'project-legacy',
      expectedLocations: ['project-legacy'],
    },
  ] as const)(
    'uses the resume location precedence for $location snapshots',
    ({ location, expectedLocations }) => {
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
        const expected = expectedLocations.map((selectedLocation) => {
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
});
