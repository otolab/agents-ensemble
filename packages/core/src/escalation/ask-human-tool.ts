import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import { formatOpenQuestionEnqueuedReport } from './format-registry-update.js';
import type {
  ChoiceOption,
  HumanInquiryResponseType,
} from './human-inquiry.js';
import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';

export interface AskHumanToolOptions {
  registry: OpenQuestionRegistry;
  /** 関連 permission が pending の間、その operator 向け要約を取得する。 */
  getPermissionSummary?: (permissionId: string) => string | undefined;
  onEnqueued?: (question: OpenQuestion) => void;
}

export function createAskHumanTool(
  options: AskHumanToolOptions,
): ConductorToolSet {
  return {
    ask_human: {
      name: 'ask_human',
      description: [
        'Register a question for the human operator when they have NOT answered yet.',
        'The operator answers in chat on a later turn; you can continue without waiting.',
        'DO NOT use if the operator already answered in chat — use answer_open_question to record their answer instead.',
        'DO NOT use answer_open_question and ask_human for the same decision in one turn.',
        'Use yes_no for binary choices, choice to offer a fixed list of quick-select options (operators may still answer in free text), or text for open guidance.',
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
            enum: ['yes_no', 'text', 'choice'],
            description:
              'yes_no for binary assent, choice for a fixed option list with free-form answers also accepted, text for open guidance',
          },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['id', 'label'],
            },
            description:
              'Required for choice: options the operator can select by id, unique label, or one-based number. Free-form answers are also accepted; an ambiguous label is recorded as answer text without selectedChoice.',
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
        const choices =
          responseType === 'choice' ? parseChoices(args.choices) : undefined;
        const relatedPermissionId = args.relatedPermissionId
          ? String(args.relatedPermissionId).trim() || undefined
          : undefined;
        const suppliedContext = args.context
          ? String(args.context).trim() || undefined
          : undefined;
        const permissionSummary = relatedPermissionId
          ? options.getPermissionSummary?.(relatedPermissionId)
          : undefined;
        const context =
          permissionSummary && !suppliedContext?.includes(permissionSummary)
            ? [permissionSummary, suppliedContext].filter(Boolean).join('\n')
            : suppliedContext;

        const entry = options.registry.enqueue({
          question,
          responseType,
          choices,
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
  if (normalized === 'yes_no' || normalized === 'choice') return normalized;
  return 'text';
}

function parseChoices(value: unknown): ChoiceOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('ask_human requires non-empty choices for responseType choice');
  }

  const choices = value.map((choice) => {
    if (!choice || typeof choice !== 'object') {
      throw new Error('ask_human choices must have string id and label fields');
    }
    const candidate = choice as Record<string, unknown>;
    const id = String(candidate.id ?? '').trim();
    const label = String(candidate.label ?? '').trim();
    if (!id || !label) {
      throw new Error('ask_human choices must have non-empty id and label fields');
    }
    return { id, label };
  });
  if (new Set(choices.map(({ id }) => id)).size !== choices.length) {
    throw new Error('ask_human choice ids must be unique');
  }
  return choices;
}
