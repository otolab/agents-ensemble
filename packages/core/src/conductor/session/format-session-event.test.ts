import { describe, expect, it } from 'vitest';
import { formatSessionEventForConductor } from './format-session-event.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

const TEST_WORKTREE = {
  path: '/tmp/worktree',
  branch: 'issue-1',
};

describe('formatSessionEventForConductor', () => {
  it('formats operator.message as plain text', () => {
    expect(
      formatSessionEventForConductor({
        type: 'operator.message',
        text: '  continue please  ',
      }),
    ).toBe('continue please');
  });

  it('formats worker.completed with YAML block', () => {
    const message = formatSessionEventForConductor({
      type: 'worker.completed',
      result: {
        name: 'ping-1',
        kind: 'ping',
        issue: TEST_ISSUE,
        worktree: TEST_WORKTREE,
        prompt: 'start',
        promptResult: {
          stopReason: 'end_turn',
          responseText: 'pong',
        },
      },
    });

    expect(message).toContain('## worker 完了');
    expect(message).toContain('```yaml');
    expect(message).toContain('name: ping-1');
    expect(message).toContain('stopReason: end_turn');
    expect(message).toContain('pong');
  });

  it('formats permission.pending with YAML block', () => {
    const message = formatSessionEventForConductor({
      type: 'permission.pending',
      permission: {
        id: 'perm-1',
        workerId: 'worker-1',
        createdAt: 1_700_000_000_000,
        request: {
          toolName: 'shell',
          sessionId: 'sess-1',
        },
      },
    });

    expect(message).toContain('## permission 判断待ち');
    expect(message).toContain('```yaml');
    expect(message).toContain('id: perm-1');
    expect(message).toContain('toolName: shell');
  });
});
