import { describe, expect, it, vi } from 'vitest';
import * as acpBridgeModule from '../acp/acp-bridge.js';
import { dispatchLibrarian } from './librarian-dispatch.js';

describe('dispatchLibrarian', () => {
  it('runs ACP session in the target repo clone', async () => {
    const connectSpy = vi.spyOn(acpBridgeModule.AcpBridge, 'connect').mockResolvedValue({
      runSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as acpBridgeModule.AcpBridge);

    const result = await dispatchLibrarian({
      skillName: 'librarian',
      repoRoot: '/repo',
      issueUrl: 'https://github.com/org/repo/issues/1',
      prUrl: 'https://github.com/org/repo/pull/2',
      spawn: { command: 'fake-agent', args: ['acp'] },
    });

    expect(result.cwd).toBe('/repo');
    expect(result.prompt).toContain('librarian');
    expect(result.prompt).toContain('/repo');
    expect(result.prompt).toContain('https://github.com/org/repo/issues/1');
    expect(result.promptResult.stopReason).toBe('end_turn');
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo' }),
    );

    connectSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
