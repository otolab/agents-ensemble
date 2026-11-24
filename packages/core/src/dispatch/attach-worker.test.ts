import { describe, expect, it } from 'vitest';
import { buildWorkerAttachPrompt, type AttachWorkerOptions } from './attach-worker.js';
import type { WorkerAcpSession } from './worker-acp-session.js';

const state = { workers: [{ name: 'worker', kind: 'explore' }], kinds: ['explore'] };

function fixture(url: string, resumed: boolean, recovery = false) {
  const issue = { url, owner: 'org', repo: 'repo', number: 42 };
  const worktree = { path: '/workspace', branch: 'main', issue };
  const options: AttachWorkerOptions = { name: 'worker', kind: 'explore', issueUrl: url, worktree, sessionState: state, handoffPending: true };
  const session = {
    issue, worktree, acpCwd: '/workspace', resumed,
    ...(recovery ? { recovery: { reason: 'explicit', previousSessionId: 'old', newSessionId: 'new' } } : {}),
  } as WorkerAcpSession;
  return { options, session };
}

describe('worker attach session recovery', () => {
  it.each(['workspace://research', 'https://github.com/org/repo/issues/42'])('uses the correct sources for %s', (url) => {
    const workspace = url.startsWith('workspace:');
    for (const [resumed, recovery] of [[true, false], [false, true]] as const) {
      const { options, session } = fixture(url, resumed, recovery);
      const prompt = buildWorkerAttachPrompt(options, session);
      expect(prompt).toContain('Notes');
      expect(prompt).toContain('中断');
      if (workspace) expect(prompt).not.toMatch(/Issue|\bPR\b|GitHub/);
      else expect(prompt).toContain('Issue');
    }
  });
});
