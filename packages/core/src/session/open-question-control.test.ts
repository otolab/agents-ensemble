import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlOperationError,
  OpenQuestionControlRemoteError,
  sendOpenQuestionControlRequest,
  startOpenQuestionControlServer,
} from './open-question-control.js';

describe('Open Question control UDS', () => {
  it('lists live questions over a private socket and removes the socket on close', async () => {
    const registry = new OpenQuestionRegistry();
    const question = registry.enqueue({
      question: 'Proceed with the release?',
      responseType: 'yes_no',
      context: 'Release decision',
      relatedPermissionId: 'perm-1',
    });
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
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
});
