import type { SDKCustomTool } from '@cursor/sdk';
import { formatOpenQuestionEnqueuedReport } from './format-registry-update.js';
import type { HumanInquiryResponseType } from './human-inquiry.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';

export interface AskHumanToolOptions {
  registry: OpenQuestionRegistry;
  onEnqueued?: (question: OpenQuestion) => void;
}

export function createAskHumanTool(
  options: AskHumanToolOptions,
): Record<string, SDKCustomTool> {
  return {
    ask_human: {
      description: [
        'Register a question for the human operator when they have NOT answered yet.',
        'The operator answers in chat on a later turn; you can continue without waiting.',
        'DO NOT use if the operator already answered in chat — use answer_open_question to record their answer instead.',
        'DO NOT use answer_open_question and ask_human for the same decision in one turn.',
        'Use yes_no for binary choices or text for open guidance.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'Question to show the human operator',
          },
          responseType: {
            type: 'string',
            enum: ['yes_no', 'text'],
            description: 'yes_no for y/n, text for free-form answer',
          },
          context: {
            type: 'string',
            description: 'Optional background shown before the question',
          },
          relatedPermissionId: {
            type: 'string',
            description:
              'Optional pending permission id when this question is about a worker permission',
          },
        },
        required: ['question'],
      },
      async execute(args) {
        const question = String(args.question ?? '').trim();
        if (!question) {
          throw new Error('ask_human requires a non-empty question');
        }

        const responseType = parseResponseType(args.responseType);
        const context = args.context ? String(args.context) : undefined;
        const relatedPermissionId = args.relatedPermissionId
          ? String(args.relatedPermissionId)
          : undefined;

        const entry = options.registry.enqueue({
          question,
          responseType,
          context,
          relatedPermissionId,
          source: 'conductor',
        });
        const report = formatOpenQuestionEnqueuedReport(entry);
        options.onEnqueued?.(entry);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: entry.id,
                  status: entry.status,
                  report,
                  message:
                    'Question recorded. Operator will answer in chat on a later turn. If they already answered, use answer_open_question. Use list_open_questions / get_open_question to inspect items.',
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            id: entry.id,
            status: entry.status,
          },
        };
      },
    },
  };
}

function parseResponseType(value: unknown): HumanInquiryResponseType {
  const normalized = String(value ?? 'text').trim().toLowerCase();
  return normalized === 'yes_no' ? 'yes_no' : 'text';
}
