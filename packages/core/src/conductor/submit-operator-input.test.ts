import { describe, expect, it, vi } from 'vitest';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import { SessionLogger } from './session/session-logger.js';
import { submitOperatorInput } from './submit-operator-input.js';

describe('submitOperatorInput', () => {
  it('enqueues operator.message and records escalation for answered open question', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      id: 'inq-1',
      question: 'Continue?',
      responseType: 'free_text',
      source: 'ask_human',
      status: 'open',
      createdAt: Date.now(),
    });

    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const emitSpy = vi.spyOn(sessionLogger, 'emit');
    const escalations: Array<{ question: string; answer: string }> = [];

    const received = submitOperatorInput({
      message: 'yes, continue',
      conductorTurn: 2,
      openQuestions: registry,
      escalations,
      eventQueue,
      sessionLogger,
    });

    expect(received).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'operator.input',
        conductorTurn: 2,
        text: expect.stringContaining('yes, continue'),
      }),
    );
    expect(eventQueue.dequeue()).toEqual(
      expect.objectContaining({
        type: 'operator.message',
        text: expect.stringContaining('yes, continue'),
      }),
    );
    expect(registry.listOpen()).toHaveLength(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.answer).toBe('yes, continue');
  });

  it('answers the targeted open question when targetOpenQuestionId is set', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({ id: 'inq-1', question: 'Q1', responseType: 'text' });
    registry.enqueue({ id: 'inq-2', question: 'Q2', responseType: 'text' });

    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const escalations: Array<{ question: string; answer: string }> = [];

    const received = submitOperatorInput({
      message: 'approved',
      targetOpenQuestionId: 'inq-2',
      conductorTurn: 2,
      openQuestions: registry,
      escalations,
      eventQueue,
      sessionLogger,
    });

    expect(received).toBe(true);
    expect(registry.listOpen()).toHaveLength(1);
    expect(registry.listOpen()[0]?.id).toBe('inq-1');
    expect(escalations[0]?.answer).toBe('approved');
  });

  it('returns false for blank input', () => {
    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });

    expect(
      submitOperatorInput({
        message: '   ',
        conductorTurn: 1,
        openQuestions: new OpenQuestionRegistry(),
        escalations: [],
        eventQueue,
        sessionLogger,
      }),
    ).toBe(false);
    expect(eventQueue.isEmpty()).toBe(true);
  });
});
