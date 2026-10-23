import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '@agents-ensemble/core/operator-runtime';
import { loadOperatorAgentState } from './operator-agent-state.js';

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
});
