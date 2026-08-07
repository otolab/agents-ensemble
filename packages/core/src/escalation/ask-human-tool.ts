import type { SDKCustomTool } from '@cursor/sdk';
import type {
  EscalationRecord,
  HumanInquiryHandler,
  HumanInquiryResponseType,
} from './human-inquiry.js';
import { createEnvFallbackHumanInquiryHandler } from './resolve-human-inquiry.js';

export interface AskHumanToolOptions {
  onAsk?: HumanInquiryHandler;
  onEscalated?: (record: EscalationRecord) => void;
}

export function createAskHumanTool(
  options: AskHumanToolOptions = {},
): Record<string, SDKCustomTool> {
  const onAsk = options.onAsk ?? createEnvFallbackHumanInquiryHandler();

  return {
    ask_human: {
      description:
        'Ask the human operator a question when you cannot decide the next action. Use yes_no for binary choices or text for open guidance.',
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

        const response = await onAsk({
          kind: 'escalation',
          question,
          responseType,
          context,
        });

        const record: EscalationRecord = {
          question,
          responseType,
          context,
          answer: response.answer,
          approved: response.approved,
        };
        options.onEscalated?.(record);

        const structuredContent: Record<string, string | boolean> = {
          answer: response.answer,
        };
        if (response.approved !== undefined) {
          structuredContent.approved = response.approved;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  answer: response.answer,
                  ...(response.approved !== undefined
                    ? { approved: response.approved }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
          structuredContent,
        };
      },
    },
  };
}

function parseResponseType(value: unknown): HumanInquiryResponseType {
  const normalized = String(value ?? 'text').trim().toLowerCase();
  return normalized === 'yes_no' ? 'yes_no' : 'text';
}
