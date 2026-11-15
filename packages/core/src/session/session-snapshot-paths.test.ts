import { describe, expect, it } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type { LocatedSessionResumeStore } from './session-resume-store.js';
import {
  sessionSnapshotPaths,
  userSessionSnapshotPaths,
} from './session-snapshot-paths.js';

const repoRoot = '/repo';
const userRoot = '/home/test/.ensemble';
const issueUrl = 'https://github.com/owner/repository/issues/1';

const located: LocatedSessionResumeStore = {
  resumeStore: {
    version: 1,
    conductorAgentId: 'agent-1',
    issueUrl,
    repoRoot: '/origin/repository',
    profile: { workers: [] },
    openQuestions: [],
    sequence: 0,
    workers: {},
    updatedAt: 0,
  },
  path: '/home/test/.ensemble/sessions/github.com/owner/repository/agent-1.json',
  location: 'canonical-slug',
};

describe('session snapshot paths', () => {
  it.each(['open-questions', 'session-state'] as const)(
    'uses only the Issue-scoped canonical path for %s',
    (kind) => {
      const paths = resolveEnsemblePaths({ repoRoot });
      const expected =
        kind === 'open-questions'
          ? paths.canonicalOpenQuestionsPath(issueUrl, 'agent-1')
          : paths.canonicalSessionStatePath(issueUrl, 'agent-1');

      expect(sessionSnapshotPaths(repoRoot, located, kind)).toEqual([expected]);
    },
  );

  it.each(['open-questions', 'session-state'] as const)(
    'uses only the user-scoped canonical path for %s',
    (kind) => {
      const paths = resolveEnsemblePaths({
        repoRoot: located.resumeStore.repoRoot,
        userEnsembleRoot: userRoot,
      });
      const expected =
        kind === 'open-questions'
          ? paths.canonicalOpenQuestionsPath(issueUrl, 'agent-1')
          : paths.canonicalSessionStatePath(issueUrl, 'agent-1');

      expect(userSessionSnapshotPaths(userRoot, located, kind)).toEqual([
        expected,
      ]);
    },
  );
});
