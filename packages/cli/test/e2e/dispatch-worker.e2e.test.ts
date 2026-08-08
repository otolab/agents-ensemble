import { describe, expect, it } from 'vitest';
import {
  hasDispatchWorkerE2eConfig,
  loadDispatchWorkerE2eConfig,
} from './test-config.js';
import { runEnsembleCli, parseCliJson } from './test-helpers.js';

const PING_SYSTEM_PROMPT =
  'これは接続テストです。調査・編集はせず、応答に pong とだけ含めて終了してください。';

describe.skipIf(!hasDispatchWorkerE2eConfig())('ensemble dispatch worker e2e', () => {
  it('runs CLI end-to-end', async () => {
    const config = loadDispatchWorkerE2eConfig()!;

    const args = [
      'dispatch',
      'worker',
      config.issueUrl,
      '--repo-root',
      config.repoRoot,
      '--name',
      config.name ?? 'ping-1',
      '--kind',
      config.kind ?? 'ping',
      '--system-prompt',
      config.systemPrompt ?? PING_SYSTEM_PROMPT,
    ];

    const { stdout, exitCode } = await runEnsembleCli(args, { timeoutMs: 300_000 });

    const result = parseCliJson<{
      stopReason: string;
      worktree: string;
      branch: string;
      issue: string;
      kind: string;
      name: string;
      responseText?: string;
    }>(stdout);

    expect(result.stopReason).toBeTruthy();
    expect(result.worktree).toContain('.ensemble/worktrees/issue-');
    expect(result.branch).toMatch(/^ensemble\/issue-\d+$/);
    expect(result.issue).toBe(config.issueUrl);
    expect(result.kind).toBe(config.kind ?? 'ping');
    expect(result.name).toBe(config.name ?? 'ping-1');
    expect(result.responseText).toContain('pong');
    expect(exitCode).toBe(0);
  }, 300_000);
});
