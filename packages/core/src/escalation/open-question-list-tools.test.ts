import { describe, expect, it } from 'vitest';
import { createOpenQuestionListTools } from './open-question-list-tools.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('createOpenQuestionListTools', () => {
  it('lists open questions', async () => {
    const registry = new OpenQuestionRegistry();
    registry.enqueue({ question: 'Q1', responseType: 'text' });
    registry.enqueue({ question: 'Q2', responseType: 'yes_no' });

    const tools = createOpenQuestionListTools({ registry });
    const result = await tools.list_open_questions.execute({ status: 'open' });

    expect(result.structuredContent).toEqual({ status: 'open', count: 2 });
  });

  it('reads one question by id', async () => {
    const registry = new OpenQuestionRegistry();
    const entry = registry.enqueue({ question: 'Detail?', responseType: 'text' });

    const tools = createOpenQuestionListTools({ registry });
    const result = await tools.get_open_question.execute({
      questionId: entry.id,
    });

    expect(result.structuredContent).toEqual({
      questionId: entry.id,
      status: 'open',
    });
  });
});
