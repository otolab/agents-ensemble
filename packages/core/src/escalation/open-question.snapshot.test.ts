import { describe, expect, it } from 'vitest';
import { OpenQuestionRegistry } from './open-question.js';

describe('OpenQuestionRegistry snapshot', () => {
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
});
