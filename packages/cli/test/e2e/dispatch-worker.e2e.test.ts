import { describe, expect, it } from 'vitest';
import {
  hasDispatchWorkerE2eConfig,
  loadDispatchWorkerE2eConfig,
} from './test-config.js';
import { runEnsembleCli, parseCliJson } from './test-helpers.js';

describe.skipIf(!hasDispatchWorkerE2eConfig())('ensemble dispatch worker e2e', () => {
  it('runs CLI end-to-end', async () => {
    const config = loadDispatchWorkerE2eConfig()!;

    const { stdout, exitCode } = await runEnsembleCli(
      [
        'dispatch',
        'worker',
        config.issueUrl,
        '--skill',
        config.skillName,
        '--repo-root',
        config.repoRoot,
      ],
      { timeoutMs: 300_000 },
    );

    const result = parseCliJson<{
      stopReason: string;
      worktree: string;
      branch: string;
      issue: string;
    }>(stdout);

    expect(result.stopReason).toBeTruthy();
    expect(result.worktree).toContain('.ensemble/worktrees/issue-');
    expect(result.branch).toMatch(/^ensemble\/issue-\d+$/);
    expect(result.issue).toBe(config.issueUrl);
    expect(exitCode).toBe(0);
  }, 300_000);
});
