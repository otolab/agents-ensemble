import type { SDKCustomTool } from '@cursor/sdk';
import { formatOpenQuestionAnsweredReport } from './format-registry-update.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';
import { recordOpenQuestionAnswer } from './record-open-question-answer.js';

export interface AnswerOpenQuestionToolOptions {
  registry: OpenQuestionRegistry;
  onAnswered?: (question: OpenQuestion) => void;
}

export function createAnswerOpenQuestionTool(
  options: AnswerOpenQuestionToolOptions,
): Record<string, SDKCustomTool> {
  return {
    answer_open_question: {
      description: [
        'Record an answer to an open question on the operator behalf.',
        'USE when the operator already answered in chat and you must close the open question before resolve_permission or the next action.',
        'USE when you are faithfully recording the operator stated intent from session context.',
        'DO NOT use when the operator has not provided guidance yet — use ask_human instead.',
        'DO NOT call ask_human and answer_open_question for the same decision in one turn.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          questionId: {
            type: 'string',
            description: 'Open question id (inq-N) from session state',
          },
          answer: {
            type: 'string',
            description: 'Answer text to record',
          },
          approved: {
            type: 'boolean',
            description: 'For yes_no questions: true/false. Omit to infer from answer text.',
          },
          rationale: {
            type: 'string',
            description:
              'Why you recorded this answer (e.g. quote from operator chat)',
          },
        },
        required: ['questionId', 'answer'],
      },
      async execute(args) {
        const questionId = String(args.questionId ?? '').trim();
        if (!questionId) {
          throw new Error('answer_open_question requires questionId');
        }

        const answer = String(args.answer ?? '').trim();
        if (!answer) {
          throw new Error('answer_open_question requires answer');
        }

        const approved =
          args.approved === undefined ? undefined : Boolean(args.approved);
        const rationale = args.rationale ? String(args.rationale) : undefined;

        const recorded = recordOpenQuestionAnswer(options.registry, {
          id: questionId,
          answer,
          approved,
          answeredBy: 'conductor',
          rationale,
        });
        if (!recorded) {
          throw new Error(
            `answer_open_question: question not found or already answered: ${questionId}`,
          );
        }

        options.onAnswered?.(recorded);

        const report = formatOpenQuestionAnsweredReport(recorded);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  questionId: recorded.id,
                  status: recorded.status,
                  answer: recorded.answer,
                  answeredBy: recorded.answeredBy,
                  report,
                  ...(recorded.approved === undefined
                    ? {}
                    : { approved: recorded.approved }),
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            questionId: recorded.id,
            status: recorded.status,
            answeredBy: recorded.answeredBy ?? 'conductor',
          },
        };
      },
    },
  };
}
