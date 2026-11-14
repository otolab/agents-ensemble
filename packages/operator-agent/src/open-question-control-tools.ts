import {
  CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT,
  CONDUCTOR_PROVIDER_HISTORY_LIMIT,
  findSessionResumeStore,
  listConductorProviderHistory,
  OPEN_QUESTION_CONTROL_METHODS,
  sendOpenQuestionControlRequest,
  type OpenQuestionControlAnswerResult,
  type OpenQuestionControlLastConductorMessage,
  type OpenQuestionControlListItem,
  type OperatorSessionShutdownMode,
  type OperatorSessionShutdownResult,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionResumeStoreDuplicateDiagnostic,
  type SessionResumeStore,
} from '@agents-ensemble/core/operator-runtime';
import { resolve } from 'node:path';

type SessionResumeStoreDiagnosticHandler = (
  diagnostic: SessionResumeStoreDuplicateDiagnostic,
) => void;

export const LIST_LIVE_OPEN_QUESTIONS_TOOL = 'list_live_open_questions';
export const ANSWER_LIVE_OPEN_QUESTION_TOOL = 'answer_live_open_question';
export const GET_LAST_CONDUCTOR_MESSAGE_TOOL = 'get_last_conductor_message';
export const LIST_CONDUCTOR_MESSAGES_TOOL = 'list_conductor_messages';
export const SEND_OPERATOR_MESSAGE_TOOL = 'send_operator_message';
export const SHUTDOWN_ISSUE_SESSION_TOOL = 'shutdown_issue_session';

interface LiveOpenQuestionsResult {
  questions: OpenQuestionControlListItem[];
}

interface LastConductorMessageResult {
  message: OpenQuestionControlLastConductorMessage | null;
}

/** Read selected user prompts and final responses from provider session history. */
export function createListConductorMessagesTool(
  repoRoot: string,
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: LIST_CONDUCTOR_MESSAGES_TOOL,
    description:
      'List up to 100 recent user prompts and final conductor responses from provider session history, including after the Issue harness stops. Defaults to 20 in descending provider order. Pass a returned providerId as an exclusive cursor to continue paging.',
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
          maximum: CONDUCTOR_PROVIDER_HISTORY_LIMIT,
          description: `Number of messages to return (default ${CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT}, maximum ${CONDUCTOR_PROVIDER_HISTORY_LIMIT}).`,
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort by provider history order; defaults to desc.',
        },
        cursor: {
          type: 'string',
          description:
            'Exclusive providerId boundary from a returned message.',
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
      const resumeStore = await requireSession(root, conductorAgentId, onDuplicate);
      const backend = resumeStore.conductorBackend ?? 'cursor';
      const limit =
        args.limit === undefined
          ? CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT
          : optionalInteger(args.limit, 'limit');
      if (limit < 1 || limit > CONDUCTOR_PROVIDER_HISTORY_LIMIT) {
        throw new Error(
          `limit must be an integer between 1 and ${CONDUCTOR_PROVIDER_HISTORY_LIMIT}.`,
        );
      }
      const order =
        args.order === undefined ? 'desc' : requireOrder(args.order);
      const cursor =
        args.cursor === undefined
          ? undefined
          : requireString(args.cursor, 'cursor');
      const result = await listConductorProviderHistory({
        backend,
        conductorAgentId,
        cwd: resumeStore.conductorCwd ?? resumeStore.repoRoot,
        repoRoot: resumeStore.repoRoot,
        issueUrl: resumeStore.issueUrl,
        ...(resumeStore.cursorBootstrapRunId
          ? { cursorBootstrapRunId: resumeStore.cursorBootstrapRunId }
          : {}),
        query: {
          limit,
          order,
          ...(cursor ? { cursor } : {}),
        },
      });
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
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
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
      const resumeStore = await requireSession(
        root,
        args.conductorAgentId,
        onDuplicate,
      );
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
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
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
      const resumeStore = await requireSession(
        root,
        args.conductorAgentId,
        onDuplicate,
      );
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
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
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
      const resumeStore = await requireSession(
        root,
        conductorAgentId,
        onDuplicate,
      );
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
export function createSendOperatorMessageTool(
  repoRoot: string,
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
): ConductorTool {
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
      const resumeStore = await requireSession(
        root,
        conductorAgentId,
        onDuplicate,
      );
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

/** Request close or exit for a running Issue harness over its live UDS. */
export function createShutdownIssueSessionTool(
  repoRoot: string,
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
): ConductorTool {
  const root = resolve(repoRoot);
  return {
    name: SHUTDOWN_ISSUE_SESSION_TOOL,
    description:
      'Request shutdown of a running Issue session. Use mode close to preserve the worktree for resume, or exit to request normal teardown and isolated worktree cleanup. This uses only the live session socket; it does not control stopped sessions. Use this dedicated tool to end a session: send_operator_message with text /close remains an ordinary conductor message.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: {
          type: 'string',
          description: 'Session id from list_operator_sessions.',
        },
        mode: {
          type: 'string',
          enum: ['close', 'exit'],
          description: 'close preserves the worktree for resume; exit requests normal teardown.',
        },
      },
      required: ['conductorAgentId', 'mode'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const mode = requireShutdownMode(args.mode);
      const resumeStore = await requireSession(
        root,
        conductorAgentId,
        onDuplicate,
      );
      const result = await sendOpenQuestionControlRequest<OperatorSessionShutdownResult>(
        requireSocketPath(resumeStore),
        {
          method: OPEN_QUESTION_CONTROL_METHODS.shutdownSession,
          params: { mode },
        },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, ConductorJsonValue>,
      };
    },
  };
}

async function requireSession(
  repoRoot: string,
  value: ConductorJsonValue | undefined,
  onDuplicate?: SessionResumeStoreDiagnosticHandler,
): Promise<SessionResumeStore> {
  const conductorAgentId = requireString(value, 'conductorAgentId');
  const located = await findSessionResumeStore(
    repoRoot,
    conductorAgentId,
    { onDuplicate },
  );
  if (!located) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }
  return located.resumeStore;
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

function requireShutdownMode(
  value: ConductorJsonValue | undefined,
): OperatorSessionShutdownMode {
  if (value !== 'close' && value !== 'exit') {
    throw new Error('mode must be close or exit.');
  }
  return value;
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

function optionalInteger(
  value: ConductorJsonValue,
  name: string,
): number {
  const number = optionalNumber(value, name);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} must be an integer.`);
  }
  return number;
}
