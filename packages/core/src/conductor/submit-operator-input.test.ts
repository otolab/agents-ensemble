import { describe, expect, it, vi } from 'vitest';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import { SessionEventQueue } from './session/session-event-queue.js';
import { SessionLogger } from './session/session-logger.js';
import {
  isOperatorInputWithinRecoveryLimit,
  submitOperatorInput,
} from './submit-operator-input.js';
import { CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT } from './conductor-recovery-inbox.js';

describe('submitOperatorInput', () => {
  it.each(['/q+', '/q-'])('enqueues %s as ordinary text and as a targeted answer', (message) => {
    for (const isAnswer of [false, true]) {
      const registry = new OpenQuestionRegistry();
      if (isAnswer) registry.enqueue({ id: 'inq-1', question: 'Path?', responseType: 'text' });
      const eventQueue = new SessionEventQueue();
      expect(submitOperatorInput({
        message, targetOpenQuestionId: isAnswer ? 'inq-1' : undefined,
        conductorTurn: 1, openQuestions: registry, escalations: [], eventQueue,
        sessionLogger: new SessionLogger({ issueUrl: 'https://github.com/org/repo/issues/1', repoRoot: '/repo' }),
      })).toBe(true);
      if (isAnswer) {
        expect(registry.get('inq-1')).toMatchObject({ status: 'answered', answer: message });
        expect(eventQueue.dequeue()).toMatchObject({ openQuestionAnswer: true, answerPreview: `inq-1: ${message}` });
      } else {
        expect(eventQueue.dequeue()).toMatchObject({ text: message, delivery: 'next' });
      }
    }
  });

  it('enqueues operator.message and records escalation for answered open question', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      id: 'inq-1',
      question: 'この変更を本番環境に反映する前に、追加の確認を行いますか？',
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
      message: 'いいえ',
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
        text: expect.stringContaining('いいえ'),
      }),
    );
    expect(eventQueue.dequeue()).toEqual(
      expect.objectContaining({
        type: 'operator.message',
        text: expect.stringContaining('いいえ'),
        operatorInput: 'いいえ',
        delivery: 'next',
        openQuestionAnswer: true,
        answerPreview: 'inq-1: いいえ',
      }),
    );
    expect(registry.listOpen()).toHaveLength(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.answer).toBe('いいえ');
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

  it('records the resolved delivery mode in both event and session log', () => {
    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const emitSpy = vi.spyOn(sessionLogger, 'emit');

    expect(
      submitOperatorInput({
        message: 'wait for active work',
        delivery: 'idle',
        conductorTurn: 3,
        openQuestions: new OpenQuestionRegistry(),
        escalations: [],
        eventQueue,
        sessionLogger,
      }),
    ).toBe(true);
    expect(eventQueue.dequeue()).toEqual({
      type: 'operator.message',
      text: 'wait for active work',
      delivery: 'idle',
    });
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'operator.input',
        delivery: 'idle',
      }),
    );
  });

  it('records targeted choice free text instead of sending it as general guidance', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      id: 'inq-1',
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ],
    });
    registry.enqueue({
      id: 'inq-2',
      question: 'Which release window?',
      responseType: 'choice',
      choices: [
        { id: 'C', label: 'This week' },
        { id: 'D', label: 'Next week' },
      ],
    });
    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const escalations: Array<{ question: string; answer: string }> = [];

    const received = submitOperatorInput({
      message: 'Release after the API compatibility pass.',
      targetOpenQuestionId: 'inq-2',
      conductorTurn: 3,
      openQuestions: registry,
      escalations,
      eventQueue,
      sessionLogger,
    });

    expect(received).toBe(true);
    expect(registry.get('inq-2')).toMatchObject({
      status: 'answered',
      answer: 'Release after the API compatibility pass.',
      answeredBy: 'operator',
    });
    expect(registry.get('inq-2')?.selectedChoice).toBeUndefined();
    expect(registry.get('inq-1')?.status).toBe('open');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.answer).toBe(
      'Release after the API compatibility pass.',
    );
    expect(eventQueue.dequeue()).toMatchObject({
      type: 'operator.message',
      text: expect.stringContaining(
        'Release after the API compatibility pass.',
      ),
    });
  });

  it('answers a sole choice question with un-targeted free text', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [{ id: 'A', label: 'Ship now' }],
    });
    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });

    const received = submitOperatorInput({
      message: 'Use a staged rollout first.',
      conductorTurn: 2,
      openQuestions: registry,
      escalations: [],
      eventQueue,
      sessionLogger,
    });

    expect(received).toBe(true);
    expect(registry.get('inq-1')).toMatchObject({
      status: 'answered',
      answer: 'Use a staged rollout first.',
      answeredBy: 'operator',
    });
    expect(registry.get('inq-1')?.selectedChoice).toBeUndefined();
    expect(eventQueue.dequeue()).toMatchObject({
      type: 'operator.message',
      text: expect.stringContaining('Use a staged rollout first.'),
    });
  });

  it('preserves blank lines in operator.input and operator.message text', () => {
    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const emitSpy = vi.spyOn(sessionLogger, 'emit');

    const received = submitOperatorInput({
      message: '段落1\n\n段落2',
      conductorTurn: 1,
      openQuestions: new OpenQuestionRegistry(),
      escalations: [],
      eventQueue,
      sessionLogger,
    });

    expect(received).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'operator.input',
      conductorTurn: 1,
      text: '段落1\n\n段落2',
      delivery: 'next',
    });
    expect(eventQueue.dequeue()).toEqual({
      type: 'operator.message',
      text: '段落1\n\n段落2',
      delivery: 'next',
    });
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

  it('admits by UTF-8 bytes and rejects oversized input before changing state', () => {
    const exactLimit =
      '界'.repeat(Math.floor(CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT / 3)) + 'a';
    const oversized = `${exactLimit}b`;
    expect(Buffer.byteLength(exactLimit, 'utf8')).toBe(
      CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
    );
    expect(isOperatorInputWithinRecoveryLimit(exactLimit)).toBe(true);
    expect(isOperatorInputWithinRecoveryLimit(oversized)).toBe(false);

    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      id: 'inq-1',
      question: 'Should this be answered?',
      responseType: 'text',
    });
    const eventQueue = new SessionEventQueue();
    const sessionLogger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const emitSpy = vi.spyOn(sessionLogger, 'emit');

    expect(
      submitOperatorInput({
        message: oversized,
        conductorTurn: 1,
        openQuestions: registry,
        escalations: [],
        eventQueue,
        sessionLogger,
      }),
    ).toBe(false);
    expect(registry.get('inq-1')?.status).toBe('open');
    expect(eventQueue.isEmpty()).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'harness.warning',
      message:
        'recovery inbox で内容を完全に保持するため、1 MiB を超える入力は受け付けません。短くするか分割してから送信してください。',
    });
    expect(JSON.stringify(emitSpy.mock.calls)).not.toContain(oversized);
  });
});
