import { mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlOperationError,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  sendOpenQuestionControlRequest,
  startOpenQuestionControlServer,
} from './open-question-control.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Open Question control UDS', () => {
  it('lists live questions over a private socket and removes the socket on close', async () => {
    const registry = new OpenQuestionRegistry();
    let lastConductorMessage: {
      text: string;
      at: number;
      sendCount: number;
    } | null = null;
    const question = registry.enqueue({
      question: 'Proceed with the release?',
      responseType: 'yes_no',
      context: 'Release decision',
      relatedPermissionId: 'perm-1',
    });
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
      getLastConductorMessage: () => lastConductorMessage,
      answerOpenQuestion: async ({ questionId, answer }) => {
        const answered = registry.answer(questionId, {
          answer,
          answeredBy: 'operator',
          assent: 'yes',
        });
        if (!answered) throw new Error('question is no longer open');
        return answered;
      },
    });
    const socketPath = server.socketPath;

    try {
      const [directory, socket] = await Promise.all([
        stat(dirname(socketPath)),
        stat(socketPath),
      ]);
      expect(directory.mode & 0o777).toBe(0o700);
      expect(socket.mode & 0o777).toBe(0o600);

      await expect(
        sendOpenQuestionControlRequest<{ questions: unknown[] }>(socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.list,
          params: {},
        }),
      ).resolves.toEqual({
        questions: [{
          id: question.id,
          question: question.question,
          responseType: 'yes_no',
          context: 'Release decision',
          askedAt: question.askedAt,
          source: 'conductor',
          relatedPermissionId: 'perm-1',
        }],
      });
      await expect(
        sendOpenQuestionControlRequest(socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.lastConductorMessageGet,
          params: {},
        }),
      ).resolves.toEqual({ message: null });
      lastConductorMessage = {
        text: 'Conductor response',
        at: 1792512003000,
        sendCount: 44,
      };
      await expect(
        sendOpenQuestionControlRequest(socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.lastConductorMessageGet,
          params: {},
        }),
      ).resolves.toEqual({
        message: {
          text: 'Conductor response',
          at: 1792512003000,
          sendCount: 44,
        },
      });
      await expect(
        sendOpenQuestionControlRequest(socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.answer,
          params: { questionId: question.id, answer: 'yes' },
        }),
      ).resolves.toEqual({
        question: {
          id: question.id,
          status: 'answered',
          answeredBy: 'operator',
          approved: true,
        },
      });
    } finally {
      await server.close();
    }

    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('routes an answer through the handler and returns protocol errors without fallback', async () => {
    const registry = new OpenQuestionRegistry();
    const question = registry.enqueue({
      question: 'Proceed?',
      responseType: 'text',
    });
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
      getLastConductorMessage: () => null,
      answerOpenQuestion: async (input) => {
        expect(input).toEqual({ questionId: question.id, answer: 'yes' });
        throw new OpenQuestionControlOperationError(
          -32004,
          'Open Question is not available.',
        );
      },
    });

    try {
      await expect(
        sendOpenQuestionControlRequest(server.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.answer,
          params: { questionId: question.id, answer: 'yes' },
        }),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        name: 'OpenQuestionControlRemoteError',
        rpcCode: -32004,
        message: 'Open Question is not available.',
      });

      await expect(
        sendOpenQuestionControlRequest(server.socketPath, {
          method: 'unknown.method',
        }),
      ).rejects.toMatchObject({
        rpcCode: -32601,
        message: 'Method not found.',
      });
    } finally {
      await server.close();
    }
  });

  it('queues operator messages with an optional delivery mode defaulting to next', async () => {
    const sendOperatorMessage = vi.fn().mockReturnValue(true);
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      answerOpenQuestion: async () => {
        throw new Error('unexpected answer request');
      },
      sendOperatorMessage,
    });

    try {
      await expect(
        sendOpenQuestionControlRequest(server.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.sendMessage,
          params: { text: 'wait until idle', delivery: 'idle' },
        }),
      ).resolves.toEqual({ queued: true, delivery: 'idle' });
      await expect(
        sendOpenQuestionControlRequest(server.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.sendMessage,
          params: { text: 'keep going' },
        }),
      ).resolves.toEqual({ queued: true, delivery: 'next' });
      expect(sendOperatorMessage.mock.calls).toEqual([
        [{ text: 'wait until idle', delivery: 'idle' }],
        [{ text: 'keep going', delivery: 'next' }],
      ]);

      await expect(
        sendOpenQuestionControlRequest(server.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.sendMessage,
          params: { text: 'bad mode', delivery: 'later' },
        }),
      ).rejects.toMatchObject({
        rpcCode: -32602,
      });
    } finally {
      await server.close();
    }
  });

  it('removes client socket listeners after receiving a response', async () => {
    const registry = new OpenQuestionRegistry();
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
      getLastConductorMessage: () => null,
      answerOpenQuestion: async () => {
        throw new Error('unexpected answer request');
      },
    });
    const createConnectionSpy = vi.spyOn(net, 'createConnection');

    try {
      await expect(
        sendOpenQuestionControlRequest(server.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.list,
        }),
      ).resolves.toEqual({ questions: [] });

      const socket = createConnectionSpy.mock.results[0]?.value as
        | Socket
        | undefined;
      expect(socket).toBeDefined();
      for (const [event, handler] of [
        ['connect', 'onConnect'],
        ['data', 'onData'],
        ['end', 'onEnd'],
        ['close', 'onClose'],
        ['error', 'onError'],
      ]) {
        expect(
          socket!.listeners(event).some((listener) => listener.name === handler),
          `${event} listener ${handler} should be removed`,
        ).toBe(false);
      }
    } finally {
      createConnectionSpy.mockRestore();
      await server.close();
    }
  });

  it('settles the client with an unknown outcome when the UDS peer ends or closes early', async () => {
    for (const peerAction of ['end', 'destroy'] as const) {
      const runtimeDirectory = await mkdtemp(
        join(tmpdir(), 'ensemble-oq-peer-close-'),
      );
      const socketPath = join(runtimeDirectory, 'peer.sock');
      const peer = createServer((socket) => {
        socket.once('data', () => {
          if (peerAction === 'end') socket.end();
          else socket.destroy();
        });
      });
      await listen(peer, socketPath);

      try {
        await expect(
          sendOpenQuestionControlRequest(socketPath, {
            method: OPEN_QUESTION_CONTROL_METHODS.answer,
            params: { questionId: 'inq-1', answer: 'yes' },
          }),
        ).rejects.toMatchObject<Partial<OpenQuestionControlTransportError>>({
          name: 'OpenQuestionControlTransportError',
          outcome: 'unknown',
        });
      } finally {
        await close(peer);
        await rm(runtimeDirectory, { recursive: true, force: true });
      }
    }
  });

  it('drains an in-flight UDS answer before closing the server and socket path', async () => {
    const registry = new OpenQuestionRegistry();
    const question = registry.enqueue({
      question: 'Proceed with shutdown?',
      responseType: 'yes_no',
    });
    const answerStarted = deferred<void>();
    const finishAnswer = deferred<void>();
    let answerCount = 0;
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
      getLastConductorMessage: () => null,
      answerOpenQuestion: async ({ questionId, answer }) => {
        answerCount += 1;
        answerStarted.resolve();
        await finishAnswer.promise;
        const answered = registry.answer(questionId, {
          answer,
          answeredBy: 'operator',
          assent: 'yes',
        });
        if (!answered) throw new Error('question is no longer open');
        return answered;
      },
    });
    const socketPath = server.socketPath;

    const request = sendOpenQuestionControlRequest(
      socketPath,
      {
        method: OPEN_QUESTION_CONTROL_METHODS.answer,
        params: { questionId: question.id, answer: 'yes' },
      },
    );
    await answerStarted.promise;
    let closeCompleted = false;
    const closing = server.close().then(() => {
      closeCompleted = true;
    });
    expect(closeCompleted).toBe(false);
    finishAnswer.resolve();

    await expect(request).resolves.toMatchObject({
      question: {
        id: question.id,
        status: 'answered',
        answeredBy: 'operator',
      },
    });
    await closing;
    expect(answerCount).toBe(1);
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues one accepted answer after its UDS peer closes without retrying it', async () => {
    const registry = new OpenQuestionRegistry();
    const question = registry.enqueue({
      question: 'Proceed?',
      responseType: 'yes_no',
    });
    const answerStarted = deferred<void>();
    const finishAnswer = deferred<void>();
    let answerCount = 0;
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
      getLastConductorMessage: () => null,
      answerOpenQuestion: async ({ questionId, answer }) => {
        answerCount += 1;
        answerStarted.resolve();
        await finishAnswer.promise;
        const answered = registry.answer(questionId, {
          answer,
          answeredBy: 'operator',
          assent: 'yes',
        });
        if (!answered) throw new Error('question is no longer open');
        return answered;
      },
    });
    const peer = createConnection(server.socketPath);
    peer.on('error', () => {});
    peer.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: OPEN_QUESTION_CONTROL_METHODS.answer,
        params: { questionId: question.id, answer: 'yes' },
      })}\n`,
    );

    try {
      await answerStarted.promise;
      peer.destroy();
      finishAnswer.resolve();
      await server.quiesce();

      expect(answerCount).toBe(1);
      expect(registry.get(question.id)).toMatchObject({
        status: 'answered',
        answeredBy: 'operator',
      });
    } finally {
      await server.close();
    }
  });
});
