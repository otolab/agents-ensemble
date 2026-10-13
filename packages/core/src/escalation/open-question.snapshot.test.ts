import { describe, expect, it } from 'vitest';
import { OpenQuestionRegistry } from './open-question.js';

describe('OpenQuestionRegistry snapshot', () => {
  it('does not answer a choice question without a valid selection', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Wait for review' },
        { id: 'B', label: 'Wait for review' },
      ],
    });

    const result = registry.answer('inq-1', {
      answer: 'Wait for review',
      answeredBy: 'operator',
    });

    expect(result).toBeUndefined();
    expect(registry.get('inq-1')).toMatchObject({
      status: 'open',
      responseType: 'choice',
    });
    expect(registry.listOpen()).toHaveLength(1);
  });

  it('restores sequence and entries', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({ question: 'Q1', responseType: 'text' });
    registry.answer('inq-1', {
      answer: 'yes',
      answeredBy: 'operator',
    });
    registry.enqueue({ question: 'Q2', responseType: 'yes_no' });

    const snapshot = registry.snapshot();
    const restored = new OpenQuestionRegistry();
    restored.restore(snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.listOpen()[0]?.id).toBe('inq-2');
    const next = restored.enqueue({ question: 'Q3', responseType: 'text' });
    expect(next.id).toBe('inq-3');
  });

  it('restores legacy approved values without recalculating them', () => {
    const legacySnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Allow the operation?',
          responseType: 'yes_no' as const,
          source: 'conductor' as const,
          status: 'answered' as const,
          askedAt: 1,
          answer: 'okです。',
          approved: false,
          answeredAt: 2,
          answeredBy: 'operator' as const,
        },
      ],
    };
    const restored = new OpenQuestionRegistry();

    restored.restore(legacySnapshot);

    expect(restored.get('inq-1')).toMatchObject({
      answer: 'okです。',
      approved: false,
    });
    expect(restored.get('inq-1')?.assent).toBeUndefined();
  });
});
