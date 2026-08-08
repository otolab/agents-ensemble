import { describe, expect, it } from 'vitest';
import { applyOperatorMessage } from './apply-operator-message.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('applyOperatorMessage', () => {
  it('answers a question by explicit id reference', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Allow shell?',
      responseType: 'yes_no',
    });

    const result = applyOperatorMessage(registry, '@inq:inq-1 yes');

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0]).toMatchObject({
      id: 'inq-1',
      status: 'answered',
      answer: 'yes',
      approved: true,
      answeredBy: 'operator',
    });
    expect(registry.listOpen()).toHaveLength(0);
  });

  it('answers the only open question with a plain message', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Next step?',
      responseType: 'text',
    });

    const result = applyOperatorMessage(registry, 'wait for review');

    expect(result.answered[0]?.answer).toBe('wait for review');
    expect(result.generalGuidance).toBeUndefined();
  });

  it('returns general guidance when multiple questions are open', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({ question: 'Q1', responseType: 'text' });
    registry.enqueue({ question: 'Q2', responseType: 'text' });

    const result = applyOperatorMessage(registry, 'focus on tests first');

    expect(result.answered).toHaveLength(0);
    expect(result.generalGuidance).toBe('focus on tests first');
    expect(registry.listOpen()).toHaveLength(2);
  });
});
