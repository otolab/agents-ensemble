import { describe, expect, it } from 'vitest';
import { hasIssueE2eConfig, loadIssueE2eConfig } from './test-config.js';
import { runEnsembleCli, parseCliJson } from './test-helpers.js';

const SMOKE_BRIEFING =
  'E2E smoke test. dispatch_worker は呼ばないこと。Issue を読んだうえで、応答に conductor-ok を含めて終了すること。';

describe.skipIf(!hasIssueE2eConfig())('ensemble issue e2e', () => {
  it('starts conductor and completes without dispatching a worker', async () => {
    const config = loadIssueE2eConfig()!;

    const { stdout, exitCode } = await runEnsembleCli(
      [
        'issue',
        config.issueUrl,
        '--repo-root',
        config.repoRoot,
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
      workerDispatchCount: number;
      lastError?: { message: string };
    }>(stdout);

    expect(result.agentId).toBeTruthy();
    expect(result.issueUrl).toBe(config.issueUrl);
    expect(result.repoRoot).toBe(config.repoRoot);
    expect(result.lastRunStatus).toBe('finished');
    expect(result.workerDispatchCount).toBe(0);
    expect(exitCode).toBe(0);
    expect(result.lastError).toBeUndefined();
  }, 300_000);
});
