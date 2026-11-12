import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from './ensemble-paths.js';

describe('resolveEnsemblePaths', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
    vi.unstubAllEnvs();
  });

  it('partitions user runtime paths by normalized repository root and retains the worktree exception', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-paths-'));
    const repoRoot = join(tempDir, 'repo');
    const paths = resolveEnsemblePaths({
      repoRoot: join(repoRoot, '.', 'src', '..'),
      home: join(tempDir, 'home'),
    });

    expect(paths.repoKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(paths.sessionsDir).toBe(
      join(tempDir, 'home', '.ensemble', 'sessions', paths.repoKey),
    );
    expect(paths.piUserDir).toBe(join(tempDir, 'home', '.ensemble', 'pi'));
    expect(dirname(paths.piWorkerDir('implementer'))).toBe(paths.piWorkerRoot);
    expect(basename(paths.piWorkerDir('implementer'))).toMatch(
      /^implementer-[a-f0-9]{12}$/u,
    );
    expect(paths.piWorkerSessionsDir('implementer')).toBe(
      join(paths.piWorkerDir('implementer'), 'sessions'),
    );
    expect(paths.piWorkerSessionMapPath('implementer')).toBe(
      join(paths.piWorkerDir('implementer'), 'session-map.json'),
    );
    const unsafeWorkerDirectory = paths.piWorkerDir('../../outside');
    expect(unsafeWorkerDirectory.startsWith(`${paths.piWorkerRoot}${sep}`)).toBe(
      true,
    );
    expect(unsafeWorkerDirectory).not.toContain(`${sep}..${sep}`);
    expect(paths.sessionResumeStorePath('agent-a')).toBe(
      join(paths.sessionsDir, 'agent-a.json'),
    );
    expect(
      paths.canonicalSessionResumeStorePath(
        'https://github.com/Org/Repo/issues/1',
        'agent-a',
      ),
    ).toBe(
      join(
        tempDir,
        'home',
        '.ensemble',
        'sessions',
        'github.com',
        'org',
        'repo',
        'agent-a.json',
      ),
    );
    expect(
      paths.canonicalOperatorAgentSessionPath(
        'https://github.com/org/repo/issues/1',
      ),
    ).toBe(
      join(
        tempDir,
        'home',
        '.ensemble',
        'operator-agent',
        'github.com',
        'org',
        'repo',
        'session.json',
      ),
    );
    expect(paths.legacySessionResumeStorePath('agent-a')).toBe(
      join(repoRoot, '.ensemble', 'sessions', 'agent-a.json'),
    );
    expect(paths.legacySessionStatePath('agent-a')).toBe(
      join(
        repoRoot,
        '.ensemble',
        'sessions',
        'agent-a',
        'session-state.yaml',
      ),
    );
    expect(paths.legacyPiSessionsDirForCwd(repoRoot)).toBe(
      join(repoRoot, '.ensemble', 'pi', 'sessions'),
    );
    expect(paths.operatorWatchStatePath).toBe(
      join(
        tempDir,
        'home',
        '.ensemble',
        'operator-agent',
        paths.repoKey,
        'watch-state.json',
      ),
    );
    expect(paths.worktreesDir).toBe(join(repoRoot, '.ensemble', 'worktrees'));

    const otherCheckout = resolveEnsemblePaths({
      repoRoot: join(tempDir, 'other-repo'),
      home: join(tempDir, 'home'),
    });
    expect(otherCheckout.repoKey).not.toBe(paths.repoKey);
  });

  it('uses ENSEMBLE_USER_ROOT for user runtime paths', () => {
    vi.stubEnv('ENSEMBLE_USER_ROOT', '/tmp/ensemble-user-root');

    const paths = resolveEnsemblePaths({ repoRoot: '/tmp/project' });

    expect(paths.userRoot).toBe('/tmp/ensemble-user-root');
    expect(paths.sessionsDir).toBe(
      join('/tmp/ensemble-user-root', 'sessions', paths.repoKey),
    );
  });
});
