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
    const issueNumber = 42;
    const workerHome = paths.piWorkerDir('implementer', issueNumber);

    expect(paths.repoKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(paths.sessionsDir).toBe(
      join(tempDir, 'home', '.ensemble', 'sessions', paths.repoKey),
    );
    expect(paths.piUserDir).toBe(join(tempDir, 'home', '.ensemble', 'pi'));
    expect(dirname(workerHome)).toBe(join(paths.piWorkerRoot, 'issue-42'));
    expect(basename(workerHome)).toMatch(
      /^implementer-[a-f0-9]{12}$/u,
    );
    expect(paths.piWorkerSessionsDir('implementer', issueNumber)).toBe(
      join(workerHome, 'sessions'),
    );
    expect(paths.piWorkerSessionMapPath('implementer', issueNumber)).toBe(
      join(
        workerHome,
        '.pi',
        'pi-acp',
        'session-map.json',
      ),
    );
    expect(paths.legacyPiWorkerDir('implementer')).toBe(
      join(
        paths.piWorkerRoot,
        basename(workerHome),
      ),
    );
    expect(paths.piWorkerDir('implementer', 43)).not.toBe(workerHome);
    expect(() => paths.piWorkerDir('implementer', 0)).toThrow(
      /positive Issue number/,
    );
    const unsafeWorkerDirectory = paths.piWorkerDir('../../outside', issueNumber);
    expect(
      unsafeWorkerDirectory.startsWith(
        `${join(paths.piWorkerRoot, 'issue-42')}${sep}`,
      ),
    ).toBe(true);
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
      paths.canonicalToolCallHistoryPath(
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
        'agent-a.tool-calls',
      ),
    );
    expect(
      paths.canonicalPiSessionsDir('https://github.com/Org/Repo/issues/1'),
    ).toBe(
      join(
        tempDir,
        'home',
        '.ensemble',
        'sessions',
        'github.com',
        'org',
        'repo',
        'pi',
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
