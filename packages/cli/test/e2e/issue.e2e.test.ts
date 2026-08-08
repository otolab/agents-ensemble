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
});
