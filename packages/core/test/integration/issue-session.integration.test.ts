import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasConductorAuth } from '../../src/conductor/conductor-auth.js';
import { runIssueSession } from '../../src/conductor/issue-session.js';
import { dispatchWorker } from '../../src/dispatch/worker-dispatch.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import type { Profile } from '../../src/profile/types.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import { getConductorModelId } from './test-config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const SMOKE_PROFILE: Profile = {
  agents: {
    ping: { systemPrompt: PING_SYSTEM_PROMPT },
  },
  workers: [{ name: 'ping-1', kind: 'ping' }],
  materials: [
    {
      id: 'integration',
      title: 'Integration',
      content:
        'worker ping-1 の応答に pong が含まれることを確認したら、conductor-ok を含めて終了すること。',
    },
  ],
};

const SMOKE_BRIEFING =
  'integration smoke test。worker の pong 確認後、応答に conductor-ok を含めて終了すること。';

describe.skipIf(!hasConductorAuth())('runIssueSession integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs conductor in agent mode with fake worker and finishes with conductor-ok', async () => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Integration smoke',
      body: SMOKE_BRIEFING,
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue(TEST_WORKTREE);

    const bridge = await createInProcessAcpBridge();

    const result = await runIssueSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      conductorCwd: REPO_ROOT,
      profile: SMOKE_PROFILE,
      modelId: getConductorModelId(),
      maxTurns: 5,
      dispatchWorker: (options) =>
        dispatchWorker({
          ...options,
          name: 'ping-1',
          bridge,
        }),
    });

    expect(result.lastRunStatus).toBe('finished');
    expect(result.stopReason).toBe('completed');
    expect(result.workerFailures).toHaveLength(0);
    expect(
      result.workerDispatches.some((entry) =>
        entry.promptResult.responseText?.includes('pong'),
      ),
    ).toBe(true);
    expect(result.lastResult).toContain('conductor-ok');
    expect(result.lastResult).not.toMatch(/プランを更新/i);
    expect(result.lastError).toBeUndefined();
  }, 300_000);
});
