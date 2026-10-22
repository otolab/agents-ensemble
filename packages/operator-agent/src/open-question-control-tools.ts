import {
  listSessionResumeStates,
  OPEN_QUESTION_CONTROL_METHODS,
  sendOpenQuestionControlRequest,
  type OpenQuestionControlAnswerResult,
  type OpenQuestionControlLastConductorMessage,
  type OpenQuestionControlListItem,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionResumeState,
} from '@agents-ensemble/core/operator-runtime';
import { resolve } from 'node:path';

export const LIST_LIVE_OPEN_QUESTIONS_TOOL = 'list_live_open_questions';
export const ANSWER_LIVE_OPEN_QUESTION_TOOL = 'answer_live_open_question';
export const GET_LAST_CONDUCTOR_MESSAGE_TOOL = 'get_last_conductor_message';
export const SEND_OPERATOR_MESSAGE_TOOL = 'send_operator_message';

interface LiveOpenQuestionsResult {
  questions: OpenQuestionControlListItem[];
}

interface LastConductorMessageResult {
  message: OpenQuestionControlLastConductorMessage | null;
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
      const resumeState = await requireSession(root, args.conductorAgentId);
      const result = await sendOpenQuestionControlRequest<LiveOpenQuestionsResult>(
        requireSocketPath(resumeState),
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
      const resumeState = await requireSession(root, args.conductorAgentId);
      const result = await sendOpenQuestionControlRequest<LastConductorMessageResult>(
        requireSocketPath(resumeState),
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
      const resumeState = await requireSession(root, conductorAgentId);
      const result = await sendOpenQuestionControlRequest<OpenQuestionControlAnswerResult>(
        requireSocketPath(resumeState),
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
      const resumeState = await requireSession(root, conductorAgentId);
      const result = await sendOpenQuestionControlRequest<{
        queued: true;
        delivery: 'idle' | 'next' | 'interrupt';
      }>(requireSocketPath(resumeState), {
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
): Promise<SessionResumeState> {
  const conductorAgentId = requireString(value, 'conductorAgentId');
  const resumeState = (await listSessionResumeStates(repoRoot)).find(
    (candidate) => candidate.conductorAgentId === conductorAgentId,
  );
  if (!resumeState) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }
  return resumeState;
}

function requireSocketPath(resumeState: SessionResumeState): string {
  if (!resumeState.harnessSocketPath) {
    throw new Error(
      `Session ${resumeState.conductorAgentId} has no recorded live control socket.`,
    );
  }
  return resumeState.harnessSocketPath;
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
