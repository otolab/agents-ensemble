import { describe, expect, it } from 'vitest';
import { buildWorkerAttachPrompt } from './build-worker-attach-prompt.js';

describe('buildWorkerAttachPrompt', () => {
  it('builds attach/wait prompt with worktree and waiting instructions', () => {
    const prompt = buildWorkerAttachPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'implementer',
      worktreePath: '/tmp/wt',
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
      systemPrompt: 'profile bootstrap',
    });

    expect(prompt).toContain('**implementer**');
    expect(prompt).toContain('作業 worktree: /tmp/wt');
    expect(prompt).toContain('init prompt');
    expect(prompt).toContain('attach 済み');
    expect(prompt).toContain('作業指示を待つ');
    expect(prompt).toContain('profile bootstrap');
  });

  it('marks in-repo mode as a special case in the prompt', () => {
    const prompt = buildWorkerAttachPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'implementer',
      worktreePath: '/repo',
      worktreeInRepo: true,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
    });

    expect(prompt).toContain('特別モード');
    expect(prompt).not.toContain('作業 worktree:');
  });
});
