import { describe, expect, it } from 'vitest';
import { hasIssueE2eConfig, loadIssueE2eConfig } from './test-config.js';
import { runEnsembleCli, parseCliJson } from './test-helpers.js';

const SMOKE_BRIEFING =
  'E2E smoke test. worker の pong 確認後、応答に conductor-ok を含めて終了すること。';

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
        '--briefing',
        SMOKE_BRIEFING,
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
      workerResponses?: Array<{ kind: string; responseText?: string }>;
      lastError?: { message: string };
    }>(stdout);

    expect(result.agentId).toBeTruthy();
    expect(result.issueUrl).toBe(config.issueUrl);
    expect(result.repoRoot).toBe(config.repoRoot);
    expect(result.lastRunStatus).toBe('finished');
    expect(result.workerDispatchCount).toBeGreaterThanOrEqual(1);
    expect(result.workerFailureCount).toBe(0);
    expect(
      result.workerResponses?.some((entry) => entry.responseText?.includes('pong')),
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
        config.profilePath,
        '--conductor-cwd',
        config.conductorCwd,
        '--model',
        config.conductorModelId,
        '--max-turns',
        '1',
        '--briefing',
        'E2E operator env test。自律ターン上限後にオペレータが continue e2e と答える想定。応答に conductor-ok を含めて終了すること。',
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
      turnCount: number;
    }>(stdout);

    expect(exitCode).toBe(0);
    expect(result.lastRunStatus).toBe('finished');
    expect(result.stopReason).toBe('completed');
    expect(result.turnCount).toBeGreaterThanOrEqual(2);
    expect(result.lastResult).toContain('conductor-ok');
  }, 300_000);
});
