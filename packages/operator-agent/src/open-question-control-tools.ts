import {
  listSessionSidecars,
  OPEN_QUESTION_CONTROL_METHODS,
  sendOpenQuestionControlRequest,
  type OpenQuestionControlAnswerResult,
  type OpenQuestionControlListItem,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionSidecar,
} from '@agents-ensemble/core/operator-runtime';
import { resolve } from 'node:path';

export const LIST_LIVE_OPEN_QUESTIONS_TOOL = 'list_live_open_questions';
export const ANSWER_LIVE_OPEN_QUESTION_TOOL = 'answer_live_open_question';

interface LiveOpenQuestionsResult {
  questions: OpenQuestionControlListItem[];
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
      const sidecar = await requireSession(root, args.conductorAgentId);
      const result = await sendOpenQuestionControlRequest<LiveOpenQuestionsResult>(
        requireSocketPath(sidecar),
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
      const sidecar = await requireSession(root, conductorAgentId);
      const result = await sendOpenQuestionControlRequest<OpenQuestionControlAnswerResult>(
        requireSocketPath(sidecar),
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

async function requireSession(
  repoRoot: string,
  value: ConductorJsonValue | undefined,
): Promise<SessionSidecar> {
  const conductorAgentId = requireString(value, 'conductorAgentId');
  const sidecar = (await listSessionSidecars(repoRoot)).find(
    (candidate) => candidate.conductorAgentId === conductorAgentId,
  );
  if (!sidecar) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }
  return sidecar;
}

function requireSocketPath(sidecar: SessionSidecar): string {
  if (!sidecar.harnessSocketPath) {
    throw new Error(
      `Session ${sidecar.conductorAgentId} has no recorded live control socket.`,
    );
  }
  return sidecar.harnessSocketPath;
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
