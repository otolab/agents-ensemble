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

  it('replaces the user config with --config and keeps project config above it', async () => {
    originalConductorModelId = process.env.CONDUCTOR_MODEL_ID;
    delete process.env.CONDUCTOR_MODEL_ID;
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-issue-config-'));
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    const userEnsembleRoot = join(repoRoot, '.test-user-ensemble');
    await mkdir(userEnsembleRoot, { recursive: true });
    await writeFile(
      join(userEnsembleRoot, 'config.yaml'),
      [
        'config:',
        '  loadProjectConfig: false',
        'conductor:',
        '  model: standard-user-model',
        'github:',
        '  auth:',
        '    allowGhAuthTokenFallback: false',
        'acp:',
        '  env:',
        '    USER_ONLY: user',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'conductor:',
        '  model: project-model',
        'acp:',
        '  env:',
        '    PROJECT_ONLY: project',
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
        '    EXPLICIT_ONLY: explicit',
        '    MODEL_PROVIDER: litellm',
        'tui:',
        '  layout: pane',
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
            userEnsembleRoot,
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
      modelId: 'project-model',
      ensembleConfig: {
        conductor: { model: 'project-model' },
        github: { auth: { allowGhAuthTokenFallback: true } },
        acp: {
          defaultPreset: 'codex',
          env: {
            EXPLICIT_ONLY: 'explicit',
            PROJECT_ONLY: 'project',
            MODEL_PROVIDER: 'project-provider',
          },
        },
        tui: { layout: 'pane' },
      },
    });
    expect(sessionOptions?.ensembleConfig?.acp.env ?? {}).not.toHaveProperty('USER_ONLY');
    expect(
      resolveDefaultAcpSpawn(sessionOptions?.defaultAcp),
    ).toMatchObject({
      preset: 'codex',
      env: {
        EXPLICIT_ONLY: 'explicit',
        INITIAL_AGENT_MODE: 'agent',
        PROJECT_ONLY: 'project',
        MODEL_PROVIDER: 'project-provider',
      },
    });
    expect(runIssueSession).toHaveBeenCalledOnce();
  });
});
