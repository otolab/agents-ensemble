import { describe, expect, it } from 'vitest';
import { hasIssueE2eConfig, loadIssueE2eConfig, OPERATOR_E2E_PROFILE_PATH, ROUNDTRIP_E2E_PROFILE_PATH } from './test-config.js';

import { runEnsembleCli, parseCliJson } from './test-helpers.js';

describe.skipIf(!hasIssueE2eConfig())('ensemble issue e2e', () => {
  it('starts workers and verifies conductor sees pong', async () => {
    const config = loadIssueE2eConfig()!;

    const { stdout, exitCode } = await runEnsembleCli(
      [
        'issue',
        config.issueUrl,
        '--repo-root',
        config.repoRoot,
        '--profile',
        config.profilePath,
        '--conductor-cwd',
        config.conductorCwd,
        '--model',
        config.conductorModelId,
      ],
      { timeoutMs: 300_000 },
    );

    const result = parseCliJson<{
      agentId: string;
      issueUrl: string;
      repoRoot: string;
      lastRunStatus: string;
      lastResult?: string;
      workerDispatchCount: number;
      workerFailureCount: number;
      workerResponses?: Array<{ kind: string; responsePreview?: string }>;
      lastError?: { message: string };
    }>(stdout);

    expect(result.agentId).toBeTruthy();
    expect(result.issueUrl).toBe(config.issueUrl);
    expect(result.repoRoot).toBe(config.repoRoot);
    expect(result.lastRunStatus).toBe('finished');
    expect(result.workerDispatchCount).toBeGreaterThanOrEqual(1);
    expect(result.workerFailureCount).toBe(0);
    expect(
      result.workerResponses?.some((entry) => entry.responsePreview?.includes('pong')),
    ).toBe(true);
    expect(result.lastResult).toContain('conductor-ok');
    expect(exitCode).toBe(0);
    expect(result.lastError).toBeUndefined();
  }, 300_000);

  it('accepts operator input via ENSEMBLE_OPERATOR_MESSAGE after max_turns', async () => {
    const config = loadIssueE2eConfig()!;

    const { stdout, exitCode } = await runEnsembleCli(
      [
        'issue',
        config.issueUrl,
        '--repo-root',
        config.repoRoot,
        '--profile',
        OPERATOR_E2E_PROFILE_PATH,
        '--conductor-cwd',
        config.conductorCwd,
        '--model',
        config.conductorModelId,
        '--max-turns',
        '1',
      ],
      {
        timeoutMs: 300_000,
        env: {
          ENSEMBLE_OPERATOR_MESSAGE: 'continue e2e',
        },
      },
    );

    const result = parseCliJson<{
      lastRunStatus: string;
      lastResult?: string;
      stopReason: string;
      sendCount: number;
    }>(stdout);

    expect(exitCode).toBe(0);
    expect(result.lastRunStatus).toBe('finished');
    expect(result.stopReason).toBe('completed');
    expect(result.sendCount).toBe(2);
    expect(result.lastResult).toContain('conductor-ok');
  }, 300_000);

  it('runs prompt_worker twice before finishing (conductor-worker roundtrip)', async () => {
    const config = loadIssueE2eConfig()!;

    const { stdout, exitCode } = await runEnsembleCli(
      [
        'issue',
        config.issueUrl,
        '--repo-root',
        config.repoRoot,
        '--profile',
        ROUNDTRIP_E2E_PROFILE_PATH,
        '--conductor-cwd',
        config.conductorCwd,
        '--model',
        config.conductorModelId,
        '--max-turns',
        '8',
      ],
      { timeoutMs: 300_000 },
    );

    const result = parseCliJson<{
      lastRunStatus: string;
      lastResult?: string;
      workerDispatchCount: number;
      workerFailureCount: number;
      workerResponses?: Array<{ name: string; responsePreview?: string }>;
      lastError?: { message: string };
    }>(stdout);

    expect(exitCode).toBe(0);
    expect(result.lastRunStatus).toBe('finished');
    expect(result.workerFailureCount).toBe(0);
    expect(result.workerDispatchCount).toBeGreaterThanOrEqual(3);
    expect(result.workerResponses?.length).toBeGreaterThanOrEqual(3);
    expect(
      result.workerResponses?.filter((entry) =>
        entry.responsePreview?.includes('pong'),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(result.lastResult).toContain('conductor-ok');
    expect(result.lastError).toBeUndefined();
  }, 300_000);
});
