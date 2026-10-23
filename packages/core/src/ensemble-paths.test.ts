import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEnsemblePaths } from './ensemble-paths.js';

describe('resolveEnsemblePaths', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
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
    expect(paths.sessionResumeStorePath('agent-a')).toBe(
      join(paths.sessionsDir, 'agent-a.json'),
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
});
