import { describe, expect, it, vi } from 'vitest';
import { createAnswerOpenQuestionTool } from './answer-open-question-tool.js';
import { SessionDialogueLog } from './dialogue-log.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('createAnswerOpenQuestionTool', () => {
  it('records an answer on behalf of the operator', async () => {
    const registry = new OpenQuestionRegistry();
    const dialogueLog = new SessionDialogueLog();
    const onAnswered = vi.fn();
    registry.enqueue({
      question: 'Allow shell?',
      responseType: 'yes_no',
    });

    const tools = createAnswerOpenQuestionTool({
      registry,
      dialogueLog,
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
      approved: true,
      answeredBy: 'conductor',
    });
    expect(result.structuredContent).toEqual({
      questionId: 'inq-1',
      status: 'answered',
      answeredBy: 'conductor',
    });
  });
});
