import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { OpenQuestion } from '../escalation/open-question.js';

export const OPEN_QUESTION_CONTROL_METHODS = {
  list: 'open_questions.list',
  answer: 'open_questions.answer',
} as const;

const JSON_RPC_VERSION = '2.0';
const MAX_MESSAGE_BYTES = 1_048_576;
const SOCKET_TIMEOUT_MS = 30_000;

export interface OpenQuestionControlAnswer {
  questionId: string;
  answer: string;
}

export type OpenQuestionControlListItem = Pick<
  OpenQuestion,
  'id' | 'question' | 'responseType' | 'source' | 'askedAt'
> &
  Partial<
    Pick<OpenQuestion, 'choices' | 'context' | 'relatedPermissionId'>
  >;

export interface OpenQuestionControlAnswerResult {
  question: Pick<OpenQuestion, 'id' | 'status'> &
    Partial<Pick<OpenQuestion, 'answeredBy' | 'approved'>>;
}

export interface OpenQuestionControlServerOptions {
  listOpenQuestions: () => OpenQuestion[];
  answerOpenQuestion: (
    input: OpenQuestionControlAnswer,
  ) => Promise<OpenQuestion>;
}

export interface OpenQuestionControlServer {
  socketPath: string;
  close: () => Promise<void>;
}

export class OpenQuestionControlOperationError extends Error {
  constructor(
    public readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenQuestionControlOperationError';
  }
}

export class OpenQuestionControlRemoteError extends Error {
  constructor(
    public readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenQuestionControlRemoteError';
  }
}

/**
 * Start a one-request-per-connection JSON-RPC server on a private Unix socket.
 * Request and response payloads are deliberately not logged.
 */
export async function startOpenQuestionControlServer(
  options: OpenQuestionControlServerOptions,
): Promise<OpenQuestionControlServer> {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'ens-oq-'));
  const socketPath = join(runtimeDirectory, 's.sock');
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let server: Server | undefined;

  try {
    await chmod(runtimeDirectory, 0o700);
    server = createServer((socket) => {
      if (closing) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
      // A client may close its write side after sending a request while it
      // continues to wait for the response.
      socket.on('error', () => {});

      let buffer = Buffer.alloc(0);
      let handled = false;
      socket.on('data', (chunk: Buffer) => {
        if (handled) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > MAX_MESSAGE_BYTES) {
          handled = true;
          writeResponse(socket, errorResponse(null, -32600, 'Request is too large.'));
          return;
        }
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) return;

        handled = true;
        socket.setTimeout(0);
        const line = buffer.subarray(0, newlineIndex).toString('utf8');
        const trailing = buffer.subarray(newlineIndex + 1);
        if (trailing.some((byte) => !isJsonWhitespace(byte))) {
          writeResponse(
            socket,
            errorResponse(null, -32600, 'Expected one request per connection.'),
          );
          return;
        }
        void handleRequest(line, options).then(
          (response) => writeResponse(socket, response),
          () =>
            writeResponse(
              socket,
              errorResponse(null, -32603, 'Open Question operation failed.'),
            ),
        );
      });
    });

    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server?.listening) {
      await closeServer(server, sockets).catch(() => {});
    }
    await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const activeServer = server!;
  return {
    socketPath,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = closeServer(activeServer, sockets).finally(async () => {
        await rm(runtimeDirectory, { recursive: true, force: true });
      });
      return closePromise;
    },
  };
}

export async function sendOpenQuestionControlRequest<T>(
  socketPath: string,
  input: {
    method: string;
    params?: Record<string, unknown>;
  },
): Promise<T> {
  const requestId = 1;
  const request = JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id: requestId,
    method: input.method,
    ...(input.params ? { params: input.params } : {}),
  });
  if (Buffer.byteLength(request) > MAX_MESSAGE_BYTES) {
    throw new Error('Open Question control request is too large.');
  }

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
      socket.destroy(new Error('Open Question control request timed out.'));
    });
    socket.on('error', reject);

    let buffer = Buffer.alloc(0);
    socket.on('connect', () => {
      socket.write(`${request}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error('Open Question control response is too large.'));
        return;
      }
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) return;
      const line = buffer.subarray(0, newlineIndex).toString('utf8');
      socket.destroy();
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (
          response.jsonrpc !== JSON_RPC_VERSION ||
          response.id !== requestId
        ) {
          reject(new Error('Invalid Open Question control response.'));
          return;
        }
        if (response.error && typeof response.error === 'object') {
          const error = response.error as Record<string, unknown>;
          reject(
            new OpenQuestionControlRemoteError(
              typeof error.code === 'number' ? error.code : -32603,
              typeof error.message === 'string'
                ? error.message
                : 'Open Question control request failed.',
            ),
          );
          return;
        }
        if (!Object.hasOwn(response, 'result')) {
          reject(new Error('Invalid Open Question control response.'));
          return;
        }
        resolve(response.result as T);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('Invalid Open Question control response.'),
        );
      }
    });
  });
}

async function handleRequest(
  line: string,
  options: OpenQuestionControlServerOptions,
): Promise<JsonRpcResponse> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, 'Parse error.');
  }

  if (!isRecord(value)) {
    return errorResponse(null, -32600, 'Invalid request.');
  }
  const requestId = value.id;
  if (
    value.jsonrpc !== JSON_RPC_VERSION ||
    !isRequestId(requestId) ||
    typeof value.method !== 'string' ||
    value.method.length === 0 ||
    (value.params !== undefined && !isRecord(value.params))
  ) {
    return errorResponse(isRequestId(requestId) ? requestId : null, -32600, 'Invalid request.');
  }
  const params = (value.params ?? {}) as Record<string, unknown>;

  try {
    switch (value.method) {
      case OPEN_QUESTION_CONTROL_METHODS.list:
        return successResponse(requestId, {
          questions: options.listOpenQuestions().map(toListItem),
        });
      case OPEN_QUESTION_CONTROL_METHODS.answer: {
        const questionId =
          typeof params.questionId === 'string' ? params.questionId.trim() : '';
        const answer =
          typeof params.answer === 'string' ? params.answer.trim() : '';
        if (!questionId || !answer) {
          return errorResponse(
            requestId,
            -32602,
            'questionId and a non-empty answer are required.',
          );
        }
        const question = await options.answerOpenQuestion({
          questionId,
          answer,
        });
        return successResponse(requestId, toAnswerResult(question));
      }
      default:
        return errorResponse(requestId, -32601, 'Method not found.');
    }
  } catch (error) {
    if (error instanceof OpenQuestionControlOperationError) {
      return errorResponse(requestId, error.rpcCode, error.message);
    }
    return errorResponse(requestId, -32603, 'Open Question operation failed.');
  }
}

function toListItem(question: OpenQuestion): OpenQuestionControlListItem {
  return {
    id: question.id,
    question: question.question,
    responseType: question.responseType,
    ...(question.choices
      ? { choices: question.choices.map((choice) => ({ ...choice })) }
      : {}),
    ...(question.context === undefined ? {} : { context: question.context }),
    askedAt: question.askedAt,
    source: question.source,
    ...(question.relatedPermissionId === undefined
      ? {}
      : { relatedPermissionId: question.relatedPermissionId }),
  };
}

function toAnswerResult(
  question: OpenQuestion,
): OpenQuestionControlAnswerResult {
  return {
    question: {
      id: question.id,
      status: question.status,
      ...(question.answeredBy === undefined
        ? {}
        : { answeredBy: question.answeredBy }),
      ...(question.approved === undefined
        ? {}
        : { approved: question.approved }),
    },
  };
}

interface JsonRpcResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function successResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function writeResponse(socket: Socket, response: JsonRpcResponse): void {
  if (socket.destroyed) return;
  const serialized = JSON.stringify(response) ?? '';
  if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
    socket.end(
      `${JSON.stringify(
        errorResponse(response.id, -32603, 'Response is too large.'),
      )}\n`,
    );
    return;
  }
  socket.end(`${serialized}\n`);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  for (const socket of sockets) socket.destroy();
  return closed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}
