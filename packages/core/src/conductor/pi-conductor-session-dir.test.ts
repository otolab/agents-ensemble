import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { piConductorSessionDir } from './pi-conductor-session-dir.js';

describe('piConductorSessionDir', () => {
  it('scopes workspace transcripts to the workspace slug', () => {
    vi.stubEnv('ENSEMBLE_USER_ROOT', '/tmp/ensemble-test-root');
    try {
      expect(piConductorSessionDir({ cwd: '/tmp/project', issueUrl: 'workspace://alpha' }))
        .toBe(join('/tmp/ensemble-test-root', 'workspaces', 'alpha', 'pi'));
      expect(piConductorSessionDir({
        cwd: '/tmp/project',
        issueUrl: 'https://github.com/Org/Repo/issues/12',
      })).toBe(join('/tmp/ensemble-test-root', 'sessions', 'github.com', 'org', 'repo', 'pi'));
      expect(() => piConductorSessionDir({ cwd: '/tmp/project', issueUrl: 'workspace://../other' }))
        .toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
