import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import { formatOpenQuestionAnsweredReport } from './format-registry-update.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';
import { recordOpenQuestionAnswer } from './record-open-question-answer.js';

export interface AnswerOpenQuestionToolOptions {
  registry: OpenQuestionRegistry;
  onAnswered?: (question: OpenQuestion) => void;
}

export function createAnswerOpenQuestionTool(
  options: AnswerOpenQuestionToolOptions,
): ConductorToolSet {
  return {
    answer_open_question: {
      name: 'answer_open_question',
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
          selectedChoice: {
            type: 'string',
            description:
              'Selected choice option id for a choice question; answer text is preserved separately',
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

        const selectedChoice = args.selectedChoice
          ? String(args.selectedChoice).trim()
          : undefined;
        const rationale = args.rationale ? String(args.rationale) : undefined;

        const recorded = recordOpenQuestionAnswer(options.registry, {
          id: questionId,
          answer,
          selectedChoice,
          answeredBy: 'conductor',
          rationale,
        });
        if (!recorded) {
          const question = options.registry.get(questionId);
          if (
            question?.status === 'open' &&
            question.responseType === 'choice'
          ) {
            throw new Error(
              `answer_open_question: choice answer must resolve to one of the listed options: ${questionId}`,
            );
          }
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
                  ...(recorded.assent === undefined
                    ? {}
                    : { assent: recorded.assent }),
                  ...(recorded.selectedChoice === undefined
                    ? {}
                    : { selectedChoice: recorded.selectedChoice }),
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
            ...(recorded.assent === undefined
              ? {}
              : { assent: recorded.assent }),
            ...(recorded.selectedChoice === undefined
              ? {}
              : { selectedChoice: recorded.selectedChoice }),
          },
        };
      },
    },
  };
}
