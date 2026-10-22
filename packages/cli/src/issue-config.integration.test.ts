import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConductorSessionResult,
  RunConductorSessionOptions,
} from '@agents-ensemble/core';
import { SessionLogger } from '@agents-ensemble/core';
import { resolveDefaultAcpSpawn } from '../../core/src/acp/resolve-acp-spawn.js';
import { loadEnsembleConfig } from '../../core/src/config/load-ensemble-config.js';
import { executeIssueCommand } from './issue-command.js';

describe('explicit config in the issue startup path', () => {
  let repoRoot = '';
  let originalConductorModelId: string | undefined;

  afterEach(async () => {
    if (originalConductorModelId === undefined) {
      delete process.env.CONDUCTOR_MODEL_ID;
    } else {
      process.env.CONDUCTOR_MODEL_ID = originalConductorModelId;
    }
    originalConductorModelId = undefined;
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
  });

  it('passes the selected model and ACP env from --config into session startup', async () => {
    originalConductorModelId = process.env.CONDUCTOR_MODEL_ID;
    delete process.env.CONDUCTOR_MODEL_ID;
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-issue-config-'));
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'conductor:',
        '  model: project-model',
        'acp:',
        '  env:',
        '    MODEL_PROVIDER: project-provider',
        '',
      ].join('\n'),
    );
    const configPath = join(repoRoot, 'litellm.config.yaml');
    await writeFile(
      configPath,
      [
        'conductor:',
        '  model: litellm-model',
        'acp:',
        '  defaultPreset: codex',
        '  env:',
        '    MODEL_PROVIDER: litellm',
        '',
      ].join('\n'),
    );

    let sessionOptions: RunConductorSessionOptions | undefined;
    const runIssueSession = vi.fn(async (options: RunConductorSessionOptions) => {
      sessionOptions = options;
      return { stopReason: 'completed' } as ConductorSessionResult;
    });

    await executeIssueCommand(
      'https://github.com/example/project/issues/42',
      {
        repoRoot,
        conductorCwd: repoRoot,
        configPath,
      },
      {
        isOperatorInputInteractive: () => false,
        isOperatorInputTty: () => false,
        loadEnsembleConfig: (root, options) =>
          loadEnsembleConfig(root, {
            ...options,
            userEnsembleRoot: join(repoRoot, '.test-user-ensemble'),
          }),
        loadProfile: async () =>
          ({
            profile: { workers: [] },
            profilePath: 'integration-profile',
          }) as never,
        runIssueSession,
        SessionLogger,
      },
    );

    expect(sessionOptions).toMatchObject({
      modelId: 'litellm-model',
      ensembleConfig: {
        conductor: { model: 'litellm-model' },
        acp: {
          defaultPreset: 'codex',
          env: { MODEL_PROVIDER: 'litellm' },
        },
      },
    });
    expect(
      resolveDefaultAcpSpawn(sessionOptions?.defaultAcp),
    ).toMatchObject({
      preset: 'codex',
      env: {
        INITIAL_AGENT_MODE: 'agent',
        MODEL_PROVIDER: 'litellm',
      },
    });
    expect(runIssueSession).toHaveBeenCalledOnce();
  });
});
