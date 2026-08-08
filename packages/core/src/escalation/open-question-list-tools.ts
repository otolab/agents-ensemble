import type { SDKCustomTool } from '@cursor/sdk';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';

export interface OpenQuestionListToolsOptions {
  registry: OpenQuestionRegistry;
}

export function createOpenQuestionListTools(
  options: OpenQuestionListToolsOptions,
): Record<string, SDKCustomTool> {
  return {
    list_open_questions: {
      description:
        'List open questions (TODO-style). Use to see pending or answered items without relying on prompt state.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'answered', 'all'],
            description: 'Filter by status. Default: open',
          },
        },
      },
      async execute(args) {
        const status = parseStatus(args.status);
        const items = filterQuestions(options.registry, status);
        const summaries = items.map(summarizeListItem);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status,
                  count: items.length,
                  items: summaries,
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            status,
            count: items.length,
          },
        };
      },
    },
    get_open_question: {
      description:
        'Read one open question by id. Use after list_open_questions when you need full detail.',
      inputSchema: {
        type: 'object',
        properties: {
          questionId: {
            type: 'string',
            description: 'Open question id (inq-N)',
          },
        },
        required: ['questionId'],
      },
      async execute(args) {
        const questionId = String(args.questionId ?? '').trim();
        if (!questionId) {
          throw new Error('get_open_question requires questionId');
        }

        const entry = options.registry.get(questionId);
        if (!entry) {
          throw new Error(`get_open_question: not found: ${questionId}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(entry, null, 2),
            },
          ],
          structuredContent: {
            questionId: entry.id,
            status: entry.status,
          },
        };
      },
    },
  };
}

function parseStatus(value: unknown): 'open' | 'answered' | 'all' {
  const normalized = String(value ?? 'open').trim().toLowerCase();
  if (normalized === 'answered' || normalized === 'all') return normalized;
  return 'open';
}

function filterQuestions(
  registry: OpenQuestionRegistry,
  status: 'open' | 'answered' | 'all',
): OpenQuestion[] {
  if (status === 'open') return registry.listOpen();
  if (status === 'answered') return registry.listAnswered();
  return registry.list();
}

function summarizeListItem(entry: OpenQuestion): Record<string, string | boolean> {
  return {
    id: entry.id,
    status: entry.status,
    question: entry.question,
    responseType: entry.responseType,
    ...(entry.answer ? { answer: entry.answer } : {}),
    ...(entry.answeredBy ? { answeredBy: entry.answeredBy } : {}),
    ...(entry.relatedPermissionId
      ? { relatedPermissionId: entry.relatedPermissionId }
      : {}),
  };
}
