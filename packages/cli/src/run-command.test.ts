import { describe, expect, it, vi } from 'vitest';
import { resolveRunResumeAgentId, runCommandExitCode } from './run-command.js';

describe('run-command', () => {
  it('maps stopReason to exit code', () => {
    expect(runCommandExitCode({ stopReason: 'complete' })).toBe(0);
    expect(runCommandExitCode({ stopReason: 'error' })).toBe(2);
  });

  it('resolves --continue via workspace slug', async () => {
    const findLatestSessionResumeStoreForWorkspace = vi.fn().mockResolvedValue({
      conductorAgentId: 'agent-ws-1',
      issueUrl: 'workspace://abc',
    });
    const result = await resolveRunResumeAgentId(
      { continue: true },
      { slugKey: 'abc', repoRoot: '/tmp/repo' },
      { findLatestSessionResumeStoreForWorkspace },
    );
    expect(result.resumeAgentId).toBe('agent-ws-1');
    expect(findLatestSessionResumeStoreForWorkspace).toHaveBeenCalledWith({
      repoRoot: '/tmp/repo',
      slugKey: 'abc',
    });
  });
});