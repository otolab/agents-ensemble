import {
  CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT,
  CONDUCTOR_MESSAGE_PAGE_MAX_LIMIT,
  listSessionResumeStores,
  OPEN_QUESTION_CONTROL_METHODS,
  sendOpenQuestionControlRequest,
  type OpenQuestionControlAnswerResult,
  type OpenQuestionControlConductorMessagesResult,
  type OpenQuestionControlLastConductorMessage,
  type OpenQuestionControlListItem,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionResumeStore,
} from '@agents-ensemble/core/operator-runtime';
import { resolve } from 'node:path';

export const LIST_LIVE_OPEN_QUESTIONS_TOOL = 'list_live_open_questions';
export const ANSWER_LIVE_OPEN_QUESTION_TOOL = 'answer_live_open_question';
export const GET_LAST_CONDUCTOR_MESSAGE_TOOL = 'get_last_conductor_message';
export const LIST_CONDUCTOR_MESSAGES_TOOL = 'list_conductor_messages';
export const SEND_OPERATOR_MESSAGE_TOOL = 'send_operator_message';

interface LiveOpenQuestionsResult {
  questions: OpenQuestionControlListItem[];
}

interface LastConductorMessageResult {
  message: OpenQuestionControlLastConductorMessage | null;
}

/** Read successful conductor responses and their matching inbound batches. */
export function createListConductorMessagesTool(repoRoot: string): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: LIST_CONDUCTOR_MESSAGES_TOOL,
    description:
      'List successful conductor responses and the full formatted inbound batch they answered from a running Issue harness. Defaults to the latest 20 in descending sendCount order. Use the last message sendCount as an exclusive cursor to continue paging. This does not read stopped sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: {
          type: 'string',
          description: 'Session id from list_operator_sessions.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: CONDUCTOR_MESSAGE_PAGE_MAX_LIMIT,
          description: `Number of messages to return (default ${CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT}, maximum ${CONDUCTOR_MESSAGE_PAGE_MAX_LIMIT}).`,
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort by sendCount; defaults to desc.',
        },
        cursor: {
          type: 'integer',
          minimum: 0,
          description:
            'Exclusive keyset boundary; with desc returns smaller sendCount values, with asc returns larger values. Cannot be combined with before or after.',
        },
        before: {
          type: 'integer',
          minimum: 0,
          description: 'Return only messages with sendCount below this value.',
        },
        after: {
          type: 'integer',
          minimum: 0,
          description: 'Return only messages with sendCount above this value.',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const resumeStore = await requireSession(root, conductorAgentId);
      const params: Record<string, unknown> = {};
      if (args.limit !== undefined) params.limit = optionalNumber(args.limit, 'limit');
      if (args.order !== undefined) params.order = requireOrder(args.order);
      if (args.cursor !== undefined) {
        params.cursor = optionalNumber(args.cursor, 'cursor');
      }
      if (args.before !== undefined) {
        params.before = optionalNumber(args.before, 'before');
      }
      if (args.after !== undefined) {
        params.after = optionalNumber(args.after, 'after');
      }
      const result =
        await sendOpenQuestionControlRequest<OpenQuestionControlConductorMessagesResult>(
          requireSocketPath(resumeStore),
          {
            method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
            params,
          },
        );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<
          string,
          ConductorJsonValue
        >,
      };
    },
  };
}

/** Read Open Questions from an active harness through its session UDS. */
export function createListLiveOpenQuestionsTool(
  repoRoot: string,
): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: LIST_LIVE_OPEN_QUESTIONS_TOOL,
    description:
      'Read open questions from a running Issue harness over its session Unix socket. This does not read or modify stopped sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: {
          type: 'string',
          description: 'Session id from list_operator_sessions.',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const resumeStore = await requireSession(root, args.conductorAgentId);
      const result = await sendOpenQuestionControlRequest<LiveOpenQuestionsResult>(
        requireSocketPath(resumeStore),
        {
          method: OPEN_QUESTION_CONTROL_METHODS.list,
          params: {},
        },
      );
      const content = JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text', text: content }],
        structuredContent: result as unknown as Record<string, ConductorJsonValue>,
      };
    },
  };
}

/** Read the last successful conductor response from an active harness. */
export function createGetLastConductorMessageTool(
  repoRoot: string,
): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: GET_LAST_CONDUCTOR_MESSAGE_TOOL,
    description:
      'Read the last successful conductor response from a running Issue harness over its session Unix socket. This does not read or modify stopped sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: {
          type: 'string',
          description: 'Session id from list_operator_sessions.',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const resumeStore = await requireSession(root, args.conductorAgentId);
      const result = await sendOpenQuestionControlRequest<LastConductorMessageResult>(
        requireSocketPath(resumeStore),
        {
          method: OPEN_QUESTION_CONTROL_METHODS.lastConductorMessageGet,
          params: {},
        },
      );
      const content = JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text', text: content }],
        structuredContent: result as unknown as Record<string, ConductorJsonValue>,
      };
    },
  };
}

/** Submit an explicit operator answer to the owning active harness. */
export function createAnswerLiveOpenQuestionTool(
  repoRoot: string,
): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: ANSWER_LIVE_OPEN_QUESTION_TOOL,
    description:
      'Submit an operator-approved answer to one open question in a running Issue harness. The harness persists the answer and normally waits for conductor dispatch before returning. If shutdown interrupts dispatch, the answer remains recorded and the result reports an unknown outcome; do not resubmit it, inspect the saved session state.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: {
          type: 'string',
          description: 'Session id from list_operator_sessions.',
        },
        questionId: {
          type: 'string',
          description: 'Open Question id (inq-N) returned by list_live_open_questions.',
        },
        answer: {
          type: 'string',
          description: 'The answer chosen by the operator.',
        },
      },
      required: ['conductorAgentId', 'questionId', 'answer'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireString(args.conductorAgentId, 'conductorAgentId');
      const questionId = requireString(args.questionId, 'questionId');
      const answer = requireString(args.answer, 'answer');
      const resumeStore = await requireSession(root, conductorAgentId);
      const result = await sendOpenQuestionControlRequest<OpenQuestionControlAnswerResult>(
        requireSocketPath(resumeStore),
        {
          method: OPEN_QUESTION_CONTROL_METHODS.answer,
          params: { questionId, answer },
        },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: {
          questionId: result.question.id,
          status: result.question.status,
          ...(result.question.answeredBy
            ? { answeredBy: result.question.answeredBy }
            : {}),
          ...(result.question.approved === undefined
            ? {}
            : { approved: result.question.approved }),
        },
      };
    },
  };
}

/** Send an operator message to a running Issue harness. */
export function createSendOperatorMessageTool(repoRoot: string): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: SEND_OPERATOR_MESSAGE_TOOL,
    description:
      'Send a message to the conductor of a running Issue session. Use delivery next by default; idle waits until the conductor has no active autonomous work, and interrupt attempts to cancel its current run before dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: {
          type: 'string',
          description: 'Session id from list_operator_sessions.',
        },
        text: {
          type: 'string',
          description: 'The operator message to send to the conductor.',
        },
        delivery: {
          type: 'string',
          enum: ['idle', 'next', 'interrupt'],
          description: 'Delivery timing; defaults to next.',
        },
      },
      required: ['conductorAgentId', 'text'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireString(args.conductorAgentId, 'conductorAgentId');
      const text = requireString(args.text, 'text');
      const delivery =
        args.delivery === undefined
          ? 'next'
          : requireDelivery(args.delivery);
      const resumeStore = await requireSession(root, conductorAgentId);
      const result = await sendOpenQuestionControlRequest<{
        queued: true;
        delivery: 'idle' | 'next' | 'interrupt';
      }>(requireSocketPath(resumeStore), {
        method: OPEN_QUESTION_CONTROL_METHODS.sendMessage,
        params: { text, delivery },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  };
}

async function requireSession(
  repoRoot: string,
  value: ConductorJsonValue | undefined,
): Promise<SessionResumeStore> {
  const conductorAgentId = requireString(value, 'conductorAgentId');
  const resumeStore = (await listSessionResumeStores(repoRoot)).find(
    (candidate) => candidate.conductorAgentId === conductorAgentId,
  );
  if (!resumeStore) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }
  return resumeStore;
}

function requireSocketPath(resumeStore: SessionResumeStore): string {
  if (!resumeStore.harnessSocketPath) {
    throw new Error(
      `Session ${resumeStore.conductorAgentId} has no recorded live control socket.`,
    );
  }
  return resumeStore.harnessSocketPath;
}

function requireString(
  value: ConductorJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireDelivery(
  value: ConductorJsonValue,
): 'idle' | 'next' | 'interrupt' {
  if (value === 'idle' || value === 'next' || value === 'interrupt') {
    return value;
  }
  throw new Error('delivery must be idle, next, or interrupt.');
}

function requireOrder(value: ConductorJsonValue): 'asc' | 'desc' {
  if (value === 'asc' || value === 'desc') return value;
  throw new Error('order must be asc or desc.');
}

function optionalNumber(
  value: ConductorJsonValue,
  name: string,
): number {
  if (typeof value !== 'number') {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}
