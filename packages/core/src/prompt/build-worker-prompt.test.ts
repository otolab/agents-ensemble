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
    expect(prompt).not.toContain('### User instructions (~/.ensemble/AGENTS.md)');
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

    expect(prompt).toContain('記載された役割に従って参照し、適用される指示に従う');
    expect(prompt).toContain('## Prepared Materials');
    expect(prompt).toContain('worker team 定義');
  });

  it('places user instructions before kind-filtered profile materials', () => {
    const prompt = buildWorkerPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'implementer',
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
        materials: [
          {
            id: 'implementer',
            title: 'Implementer material',
            content: 'implementer-only guidance',
            kinds: ['implementer'],
          },
        ],
      },
      userInstructions: {
        id: 'user-instructions',
        title: 'User instructions (~/.ensemble/AGENTS.md)',
        content: 'Shared guidance for all workers',
      },
    });

    expect(prompt).toContain('### User instructions (~/.ensemble/AGENTS.md)');
    expect(prompt).toContain('Shared guidance for all workers');
    expect(prompt.indexOf('### User instructions')).toBeLessThan(
      prompt.indexOf('### Implementer material'),
    );
    expect(prompt).not.toContain('Issue context');
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
