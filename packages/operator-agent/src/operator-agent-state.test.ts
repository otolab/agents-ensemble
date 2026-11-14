import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';
import {
  loadOperatorAgentState,
  operatorAgentStatePath,
  saveOperatorAgentState,
} from './operator-agent-state.js';

describe('operator-agent state', () => {
  let home = '';
  let repoRoot = '';

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
    home = '';
    repoRoot = '';
  });

  it('loads a legacy project state and migrates it to the user-scoped path', async () => {
    home = await mkdtemp(join(tmpdir(), 'ensemble-operator-state-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(home, '.ensemble'));
    repoRoot = join(home, 'repository');
    const paths = resolveEnsemblePaths({ repoRoot });
    const state = {
      version: 1,
      agentId: 'operator-agent-1',
      backend: 'pi',
      repoRoot,
    };
    await mkdir(dirname(paths.legacyOperatorAgentSessionPath), {
      recursive: true,
    });
    await writeFile(
      paths.legacyOperatorAgentSessionPath,
      `${JSON.stringify(state)}\n`,
      'utf8',
    );

    await expect(loadOperatorAgentState(repoRoot)).resolves.toEqual(state);
    await expect(
      readFile(paths.operatorAgentSessionPath, 'utf8'),
    ).resolves.toContain('operator-agent-1');
    await expect(
      readFile(paths.legacyOperatorAgentSessionPath, 'utf8'),
    ).resolves.toContain('operator-agent-1');
  });

  it('prefers and continues the canonical slug operator session beside a stale hash copy', async () => {
    home = await mkdtemp(join(tmpdir(), 'ensemble-operator-state-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(home, '.ensemble'));
    repoRoot = join(home, 'repository');
    const paths = resolveEnsemblePaths({ repoRoot });
    const issueUrl = 'https://github.com/org/repo/issues/12';
    const hashStorePath = paths.sessionResumeStorePath('conductor-12');
    const slugStorePath = paths.canonicalSessionResumeStorePath(
      issueUrl,
      'conductor-12',
    );
    const resumeStore = {
      version: 1,
      conductorAgentId: 'conductor-12',
      issueUrl,
      repoRoot,
      profile: { workers: [] },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 12,
    };
    await mkdir(dirname(hashStorePath), { recursive: true });
    await mkdir(dirname(slugStorePath), { recursive: true });
    await writeFile(hashStorePath, JSON.stringify(resumeStore), 'utf8');
    await writeFile(slugStorePath, JSON.stringify(resumeStore), 'utf8');

    const staleState = {
      version: 1,
      agentId: 'operator-hash',
      backend: 'pi',
      repoRoot,
    };
    const canonicalState = {
      ...staleState,
      agentId: 'operator-slug',
    };
    const hashStatePath = paths.operatorAgentSessionPath;
    const canonicalStatePath =
      paths.canonicalOperatorAgentSessionPath(issueUrl);
    await mkdir(dirname(hashStatePath), { recursive: true });
    await mkdir(dirname(canonicalStatePath), { recursive: true });
    await writeFile(hashStatePath, `${JSON.stringify(staleState)}\n`, 'utf8');
    await writeFile(
      canonicalStatePath,
      `${JSON.stringify(canonicalState)}\n`,
      'utf8',
    );

    await expect(loadOperatorAgentState(repoRoot)).resolves.toEqual(
      canonicalState,
    );
    await saveOperatorAgentState(repoRoot, {
      ...canonicalState,
      agentId: 'operator-slug-updated',
    });
    await expect(readFile(canonicalStatePath, 'utf8')).resolves.toContain(
      'operator-slug-updated',
    );
    await expect(readFile(hashStatePath, 'utf8')).resolves.toContain(
      'operator-hash',
    );
  });

  it('migrates hash operator state to the selected slug key without removing the hash copy', async () => {
    home = await mkdtemp(join(tmpdir(), 'ensemble-operator-state-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(home, '.ensemble'));
    repoRoot = join(home, 'repository');
    const paths = resolveEnsemblePaths({ repoRoot });
    const issueUrl = 'https://github.com/org/repo-migrated/issues/13';
    const agentId = 'conductor-13';
    const hashResumePath = paths.sessionResumeStorePath(agentId);
    const slugResumePath = paths.canonicalSessionResumeStorePath(
      issueUrl,
      agentId,
    );
    const resumeStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot,
      profile: { workers: [] },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 13,
    };
    await mkdir(dirname(hashResumePath), { recursive: true });
    await mkdir(dirname(slugResumePath), { recursive: true });
    await writeFile(hashResumePath, JSON.stringify(resumeStore), 'utf8');
    await writeFile(slugResumePath, JSON.stringify(resumeStore), 'utf8');
    const originalHashState = {
      version: 1,
      agentId: 'operator-hash-fallback',
      backend: 'pi',
      repoRoot,
    };
    const hashStatePath = paths.operatorAgentSessionPath;
    await mkdir(dirname(hashStatePath), { recursive: true });
    await writeFile(hashStatePath, `${JSON.stringify(originalHashState)}\n`);

    await expect(loadOperatorAgentState(repoRoot)).resolves.toEqual(
      originalHashState,
    );
    const slugStatePath = operatorAgentStatePath(repoRoot, {
      location: 'canonical-slug',
      issueUrl,
    });
    await expect(readFile(slugStatePath, 'utf8')).resolves.toContain(
      'operator-hash-fallback',
    );
    await expect(readFile(hashStatePath, 'utf8')).resolves.toContain(
      'operator-hash-fallback',
    );
  });

  it('uses the hash operator state when the selected ResumeStore is hash-only despite an orphan slug state', async () => {
    home = await mkdtemp(join(tmpdir(), 'ensemble-operator-state-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(home, '.ensemble'));
    repoRoot = join(home, 'repository');
    const paths = resolveEnsemblePaths({ repoRoot });
    const issueUrl = 'https://github.com/org/repo-hash-only/issues/14';
    const agentId = 'conductor-14';
    const hashResumePath = paths.sessionResumeStorePath(agentId);
    const resumeStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot,
      profile: { workers: [] },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 14,
    };
    await mkdir(dirname(hashResumePath), { recursive: true });
    await writeFile(hashResumePath, JSON.stringify(resumeStore), 'utf8');
    const hashState = {
      version: 1,
      agentId: 'operator-hash-selected',
      backend: 'pi',
      repoRoot,
    };
    const orphanSlugState = {
      ...hashState,
      agentId: 'orphan-slug-must-not-win',
    };
    const hashStatePath = paths.operatorAgentSessionPath;
    const orphanSlugPath =
      paths.canonicalOperatorAgentSessionPath(issueUrl);
    await mkdir(dirname(hashStatePath), { recursive: true });
    await mkdir(dirname(orphanSlugPath), { recursive: true });
    await writeFile(hashStatePath, `${JSON.stringify(hashState)}\n`);
    await writeFile(orphanSlugPath, `${JSON.stringify(orphanSlugState)}\n`);

    await expect(loadOperatorAgentState(repoRoot)).resolves.toEqual(hashState);
    await expect(readFile(orphanSlugPath, 'utf8')).resolves.toContain(
      'orphan-slug-must-not-win',
    );
  });

  it('uses the hash operator state when selected sessions span multiple canonical slugs', async () => {
    home = await mkdtemp(join(tmpdir(), 'ensemble-operator-state-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(home, '.ensemble'));
    repoRoot = join(home, 'repository');
    const paths = resolveEnsemblePaths({ repoRoot });
    const sessions = [
      {
        agentId: 'conductor-old-repo',
        issueUrl: 'https://github.com/org/repo-old/issues/15',
      },
      {
        agentId: 'conductor-new-repo',
        issueUrl: 'https://github.com/org/repo-new/issues/16',
      },
    ];
    for (const { agentId, issueUrl } of sessions) {
      const storePath = paths.canonicalSessionResumeStorePath(
        issueUrl,
        agentId,
      );
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          conductorAgentId: agentId,
          issueUrl,
          repoRoot,
          profile: { workers: [] },
          openQuestions: [],
          sequence: 0,
          workers: {},
          updatedAt: 16,
        }),
        'utf8',
      );
    }
    const hashState = {
      version: 1,
      agentId: 'operator-hash-for-multiple-slugs',
      backend: 'pi',
      repoRoot,
    };
    const hashStatePath = paths.operatorAgentSessionPath;
    await mkdir(dirname(hashStatePath), { recursive: true });
    await writeFile(hashStatePath, `${JSON.stringify(hashState)}\n`, 'utf8');

    await expect(loadOperatorAgentState(repoRoot)).resolves.toEqual(hashState);
    await saveOperatorAgentState(repoRoot, {
      ...hashState,
      agentId: 'operator-hash-updated',
    });
    await expect(readFile(hashStatePath, 'utf8')).resolves.toContain(
      'operator-hash-updated',
    );
    for (const { issueUrl } of sessions) {
      await expect(
        readFile(paths.canonicalOperatorAgentSessionPath(issueUrl), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

});
