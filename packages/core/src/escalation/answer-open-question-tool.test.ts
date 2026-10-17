import { describe, expect, it, vi } from 'vitest';
import { createAnswerOpenQuestionTool } from './answer-open-question-tool.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('createAnswerOpenQuestionTool', () => {
  it('records an answer on behalf of the operator', async () => {
    const registry = new OpenQuestionRegistry();
    const onAnswered = vi.fn();
    registry.enqueue({
      question: 'Allow shell?',
      responseType: 'yes_no',
      relatedPermissionId: 'perm-1',
    });

    const tools = createAnswerOpenQuestionTool({
      registry,
      onAnswered,
    });
    const result = await tools.answer_open_question.execute({
      questionId: 'inq-1',
      answer: 'yes',
      rationale: 'Operator said yes in chat',
    });

    expect(onAnswered).toHaveBeenCalledOnce();
    expect(registry.listAnswered()[0]).toMatchObject({
      id: 'inq-1',
      answer: 'yes',
      assent: 'yes',
      approved: true,
      answeredBy: 'conductor',
    });
    expect(result.structuredContent).toEqual({
      questionId: 'inq-1',
      status: 'answered',
      answeredBy: 'conductor',
      assent: 'yes',
    });
  });

  it('does not derive approved for an unlinked yes_no question', async () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({ question: 'Proceed?', responseType: 'yes_no' });
    const tools = createAnswerOpenQuestionTool({ registry });

    await tools.answer_open_question.execute({
      questionId: 'inq-1',
      answer: 'yes',
    });

    expect(registry.listAnswered()[0]).toMatchObject({
      answer: 'yes',
      assent: 'yes',
    });
    expect(registry.listAnswered()[0]?.approved).toBeUndefined();
  });

  it('records selectedChoice from a choice answer', async () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ],
    });
    const tools = createAnswerOpenQuestionTool({ registry });

    await tools.answer_open_question.execute({
      questionId: 'inq-1',
      answer: 'The operator chose the second option.',
      selectedChoice: 'B',
    });

    expect(registry.listAnswered()[0]).toMatchObject({
      answer: 'The operator chose the second option.',
      selectedChoice: 'B',
    });
  });

  it('records unresolved free text for a choice question without selectedChoice', async () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ],
    });
    const tools = createAnswerOpenQuestionTool({ registry });

    const result = await tools.answer_open_question.execute({
      questionId: 'inq-1',
      answer: 'The operator prefers a staged rollout.',
    });

    expect(registry.listAnswered()).toMatchObject([
      {
        id: 'inq-1',
        status: 'answered',
        responseType: 'choice',
        answer: 'The operator prefers a staged rollout.',
        answeredBy: 'conductor',
      },
    ]);
    expect(registry.listAnswered()[0]?.selectedChoice).toBeUndefined();
    expect(registry.listOpen()).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      questionId: 'inq-1',
      status: 'answered',
      answeredBy: 'conductor',
    });
    expect(result.structuredContent).not.toHaveProperty('selectedChoice');
  });

  it('keeps an ambiguous choice label as free text when answering through the tool', async () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({
      question: 'Which approach?',
      responseType: 'choice',
      choices: [
        { id: 'A', label: 'Wait for review' },
        { id: 'B', label: 'Wait for review' },
      ],
    });
    const tools = createAnswerOpenQuestionTool({ registry });

    await tools.answer_open_question.execute({
      questionId: 'inq-1',
      answer: 'Wait for review',
    });

    expect(registry.listAnswered()).toMatchObject([
      {
        status: 'answered',
        answer: 'Wait for review',
      },
    ]);
    expect(registry.listAnswered()[0]?.selectedChoice).toBeUndefined();
  });
});
