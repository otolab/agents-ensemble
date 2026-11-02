import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';
import {
  loadOperatorAgentState,
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

});
