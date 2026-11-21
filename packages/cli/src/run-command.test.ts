import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '@agents-ensemble/core';
import { executeRunCommand, resolveRunResumeAgentId, runCommandExitCode } from './run-command.js';

describe('run-command', () => {
  it('passes the selected bundled profile to the workspace session', async () => {
    const runConductorSession = vi.fn().mockResolvedValue({ stopReason: 'complete' });
    const SessionLogger = vi.fn().mockImplementation(() => ({
      subscribe: vi.fn(),
      emit: vi.fn(),
    }));
    await executeRunCommand({
      repoRoot: '/tmp', conductorCwd: '/tmp', briefPath: 'brief.md',
      profile: 'workspace-research',
    }, {
      resolveWorkspaceSlugKey: vi.fn().mockResolvedValue('smoke'),
      readBriefFile: vi.fn().mockResolvedValue('調査する'),
      loadEnsembleConfig: vi.fn().mockResolvedValue(DEFAULT_ENSEMBLE_CONFIG),
      isOperatorInputInteractive: () => false,
      isOperatorInputTty: () => false,
      isOperatorRecoveryInspectionTty: () => false,
      runConductorSession,
      SessionLogger,
    });
    expect(runConductorSession).toHaveBeenCalledWith(expect.objectContaining({
      issueUrl: 'workspace://smoke',
      workerWorktreeMode: 'in_repo',
      disableGitHubMonitor: true,
      profile: expect.objectContaining({
        workers: expect.arrayContaining([
          expect.objectContaining({ kind: 'explore' }),
          expect.objectContaining({ kind: 'librarian' }),
        ]),
      }),
      profilePath: expect.stringContaining('workspace-research'),
    }));
  });

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
