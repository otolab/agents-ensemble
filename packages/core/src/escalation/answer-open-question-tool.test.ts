import { describe, expect, it, vi } from 'vitest';
import { createAnswerOpenQuestionTool } from './answer-open-question-tool.js';
import { createOpenQuestionListTools } from './open-question-list-tools.js';
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

  it('keeps an unresolved choice open and allows a valid answer after restore', async () => {
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

    await expect(
      tools.answer_open_question.execute({
        questionId: 'inq-1',
        answer: 'Wait for review',
      }),
    ).rejects.toThrow(/choice answer must resolve/u);

    expect(registry.get('inq-1')).toMatchObject({
      id: 'inq-1',
      status: 'open',
      responseType: 'choice',
    });
    expect(registry.get('inq-1')?.answer).toBeUndefined();
    expect(registry.listAnswered()).toHaveLength(0);

    const restored = new OpenQuestionRegistry();
    restored.restore(registry.snapshot());
    const listTools = createOpenQuestionListTools({ registry: restored });
    const listed = await listTools.list_open_questions.execute({
      status: 'open',
    });
    const listedBody = JSON.parse(String(listed.content[0]?.text));

    expect(listedBody).toMatchObject({
      status: 'open',
      count: 1,
      items: [{ id: 'inq-1', status: 'open', responseType: 'choice' }],
    });

    const retryTools = createAnswerOpenQuestionTool({ registry: restored });
    await retryTools.answer_open_question.execute({
      questionId: 'inq-1',
      answer: 'The operator selected option B after review.',
      selectedChoice: 'B',
    });

    expect(restored.listAnswered()).toMatchObject([
      {
        id: 'inq-1',
        status: 'answered',
        answer: 'The operator selected option B after review.',
        selectedChoice: 'B',
      },
    ]);
    expect(restored.listOpen()).toHaveLength(0);
  });
});
