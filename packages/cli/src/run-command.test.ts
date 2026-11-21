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

  it('reports a missing session and rejects conflicting resume options', async () => {
    const context = { slugKey: 'abc', repoRoot: '/tmp/repo' };
    await expect(resolveRunResumeAgentId(
      { continue: true }, context,
      { findLatestSessionResumeStoreForWorkspace: vi.fn().mockResolvedValue(undefined) },
    )).rejects.toThrow('No saved session resume store');
    await expect(resolveRunResumeAgentId({ continue: true, resume: 'id' }, context))
      .rejects.toThrow('Cannot use --continue and --resume together');
  });
});
