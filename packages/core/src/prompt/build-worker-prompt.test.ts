import { describe, expect, it } from 'vitest';
import { KIND_FILTER_SESSION_STATE } from './testing/test-profile.js';
import { buildWorkerPrompt } from './build-worker-prompt.js';

describe('buildWorkerPrompt', () => {
  it('merges Base + WorkerBase + profile and applies kind context', () => {
    const prompt = buildWorkerPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'ping',
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      agentModule: {
        instructions: ['profile 固有: respond with pong'],
      },
      worktreePath: '/tmp/wt',
    });

    expect(prompt).toContain('**ping**');
    expect(prompt).toContain('Issue #1');
    expect(prompt).toContain('profile 固有: respond with pong');
    expect(prompt).toContain('https://github.com/org/repo/issues/1');
  });

  it('includes profile materials from session state', () => {
    const prompt = buildWorkerPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'implementer',
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
        materials: [
          {
            id: 'team',
            title: 'Team definition',
            content: 'worker team 定義',
          },
        ],
      },
    });

    expect(prompt).toContain('行動時の定義として読み、従う');
    expect(prompt).toContain('## Prepared Materials');
    expect(prompt).toContain('worker team 定義');
  });

  it('includes common and matching materials only', () => {
    const prompt = buildWorkerPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'implementer',
      sessionState: KIND_FILTER_SESSION_STATE,
    });

    expect(prompt).toContain('fixture common material');
    expect(prompt).toContain('fixture implementer-only material');
    expect(prompt).not.toContain('fixture conductor-only material');
    expect(prompt).not.toContain('fixture reviewer-only material');
  });
});
