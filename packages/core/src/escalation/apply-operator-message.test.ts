import { describe, expect, it } from 'vitest';
import { applyOperatorMessage } from './apply-operator-message.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('applyOperatorMessage', () => {
  it('answers a question by targetQuestionId option', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Allow shell?',
      responseType: 'yes_no',
      relatedPermissionId: 'perm-1',
    });

    const result = applyOperatorMessage(registry, 'yes', {
      targetQuestionId: 'inq-1',
    });

    expect(result.answered).toHaveLength(1);
    expect(result.answered[0]).toMatchObject({
      id: 'inq-1',
      status: 'answered',
      answer: 'yes',
      assent: 'yes',
      approved: true,
      answeredBy: 'operator',
    });
    expect(registry.listOpen()).toHaveLength(0);
  });

  it.each([
    ['yes', 'yes', true],
    ['OKです。', 'yes', true],
    ['no', 'no', false],
    ['いいえ', 'no', false],
    ['maybe', 'unclear', undefined],
    ['まだ決められません', 'unclear', undefined],
  ] as const)(
    'records %j as %s and derives approval only for permission-linked questions',
    (answer, assent, approved) => {
      const registry = new OpenQuestionRegistry();
      registry.enqueue({
        question: 'Allow shell?',
        responseType: 'yes_no',
        relatedPermissionId: 'perm-1',
      });

      const result = applyOperatorMessage(registry, answer);

      expect(result.answered[0]).toMatchObject({ answer, assent });
      expect(result.answered[0]?.approved).toBe(approved);
    },
  );

  it('retains assent without approved for an unlinked yes_no question', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Proceed with this plan?',
      responseType: 'yes_no',
    });

    const result = applyOperatorMessage(registry, 'okです。');

    expect(result.answered[0]).toMatchObject({
      answer: 'okです。',
      assent: 'yes',
    });
    expect(result.answered[0]?.approved).toBeUndefined();
  });

  it('does not accept a caller supplied approved value without clear assent', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Allow shell?',
      responseType: 'yes_no',
      relatedPermissionId: 'perm-1',
    });

    registry.answer('inq-1', {
      answer: 'maybe',
      assent: 'unclear',
      approved: true,
      answeredBy: 'operator',
    });

    expect(registry.get('inq-1')).toMatchObject({ assent: 'unclear' });
    expect(registry.get('inq-1')?.approved).toBeUndefined();
  });

  it.each([
    ['B', 'B'],
    ['2', 'B'],
    ['Wait for review', 'B'],
  ])(
    'records choice input %j as option %s and keeps the full answer',
    (answer, selectedChoice) => {
      const registry = new OpenQuestionRegistry();
      registry.enqueue({
        question: 'Which approach?',
        responseType: 'choice',
        choices: [
          { id: 'A', label: 'Ship now' },
          { id: 'B', label: 'Wait for review' },
        ],
      });

      const result = applyOperatorMessage(registry, answer, {
        targetQuestionId: 'inq-1',
      });

      expect(result.answered[0]).toMatchObject({
        answer,
        selectedChoice,
      });
      expect(result.answered[0]?.approved).toBeUndefined();
    },
  );

  it('records unlisted free text for a choice question without selecting an option', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ],
    });

    const result = applyOperatorMessage(
      registry,
      'Use a staged rollout first.',
      { targetQuestionId: 'inq-1' },
    );

    expect(result).toMatchObject({
      answered: [
        {
          id: 'inq-1',
          status: 'answered',
          answer: 'Use a staged rollout first.',
          answeredBy: 'operator',
        },
      ],
    });
    expect(result.answered[0]?.selectedChoice).toBeUndefined();
    expect(result.generalGuidance).toBeUndefined();
    expect(registry.listOpen()).toHaveLength(0);
  });

  it('records an ambiguous choice label as free text without guessing an option', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Wait for review' },
        { id: 'B', label: 'Wait for review' },
      ],
    });

    const ambiguous = applyOperatorMessage(registry, 'Wait for review', {
      targetQuestionId: 'inq-1',
    });

    expect(ambiguous.answered).toMatchObject([
      {
        id: 'inq-1',
        status: 'answered',
        answer: 'Wait for review',
      },
    ]);
    expect(ambiguous.answered[0]?.selectedChoice).toBeUndefined();
    expect(ambiguous.generalGuidance).toBeUndefined();
    expect(registry.listOpen()).toHaveLength(0);
  });

  it('answers the only open choice question with un-targeted free text', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [{ id: 'A', label: 'Ship now' }],
    });

    const result = applyOperatorMessage(registry, 'Use a staged rollout.');

    expect(result.answered[0]).toMatchObject({
      status: 'answered',
      answer: 'Use a staged rollout.',
    });
    expect(result.answered[0]?.selectedChoice).toBeUndefined();
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

  it('answers a specific question among many when targetQuestionId is set', () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({ id: 'inq-1', question: 'Q1', responseType: 'text' });
    registry.enqueue({ id: 'inq-2', question: 'Q2', responseType: 'text' });

    const result = applyOperatorMessage(registry, 'approved', {
      targetQuestionId: 'inq-2',
    });

    expect(result.answered[0]?.id).toBe('inq-2');
    expect(registry.listOpen()).toHaveLength(1);
    expect(registry.listOpen()[0]?.id).toBe('inq-1');
  });
});
