import { describe, expect, it } from 'vitest';
import {
  canTriggerConductorDispatch,
  isTriggerSessionEvent,
  sessionEventDispatchMode,
} from './dispatch-mode.js';
import type { SessionEvent } from './session-event.js';

describe('dispatch-mode', () => {
  it('defaults SessionEvent dispatch mode to trigger', () => {
    const event: SessionEvent = {
      type: 'worker.completed',
      result: {
        name: 'implementer',
        kind: 'implementer',
        issue: {
          owner: 'o',
          repo: 'r',
          number: 1,
          url: 'https://github.com/o/r/issues/1',
        },
        worktree: {
          path: '/wt',
          branch: 'b',
          issue: {
            owner: 'o',
            repo: 'r',
            number: 1,
            url: 'https://github.com/o/r/issues/1',
          },
        },
        prompt: 'p',
        promptResult: { stopReason: 'end_turn' },
        acpSessionId: 's',
      },
    };

    expect(sessionEventDispatchMode(event)).toBe('trigger');
    expect(isTriggerSessionEvent(event)).toBe(true);
    expect(canTriggerConductorDispatch('inform')).toBe(false);
  });

  it('excludes inform SessionEvent from trigger dispatch', () => {
    const event: SessionEvent = {
      type: 'worker.completed',
      dispatchMode: 'inform',
      result: {
        name: 'implementer',
        kind: 'implementer',
        issue: {
          owner: 'o',
          repo: 'r',
          number: 1,
          url: 'https://github.com/o/r/issues/1',
        },
        worktree: {
          path: '/wt',
          branch: 'b',
          issue: {
            owner: 'o',
            repo: 'r',
            number: 1,
            url: 'https://github.com/o/r/issues/1',
          },
        },
        prompt: 'p',
        promptResult: { stopReason: 'end_turn' },
        acpSessionId: 's',
      },
    };

    expect(sessionEventDispatchMode(event)).toBe('inform');
    expect(isTriggerSessionEvent(event)).toBe(false);
  });
});
