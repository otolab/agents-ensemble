import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenQuestionRegistry } from '../../core/src/escalation/open-question.js';
import { recordOpenQuestionAnswer } from '../../core/src/escalation/record-open-question-answer.js';
import {
  startOpenQuestionControlServer,
  type OpenQuestionControlServer,
} from '../../core/src/session/open-question-control.js';
import {
  saveSessionSidecar,
  sessionSidecarPath,
  SESSION_SIDECAR_VERSION,
} from '../../core/src/session/session-sidecar.js';
import {
  createAnswerLiveOpenQuestionTool,
  createGetLastConductorMessageTool,
  createListLiveOpenQuestionsTool,
} from './open-question-control-tools.js';

describe('operator-agent live Open Question tools', () => {
  let repoRoot: string | undefined;
  let server: OpenQuestionControlServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  it('lists and answers through the socket recorded in the session sidecar', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-live-'));
    const registry = new OpenQuestionRegistry();
    const question = registry.enqueue({
      question: 'Proceed?',
      responseType: 'yes_no',
      relatedPermissionId: 'perm-1',
    });
    server = await startOpenQuestionControlServer({
      listOpenQuestions: () => registry.listOpen(),
      getLastConductorMessage: () => ({
        text: 'The conductor response.',
        at: 1792512003000,
        sendCount: 44,
      }),
      answerOpenQuestion: async ({ questionId, answer }) => {
        const answered = recordOpenQuestionAnswer(registry, {
          id: questionId,
          answer,
          answeredBy: 'operator',
        });
        if (!answered) throw new Error('question is no longer open');
        return answered;
      },
    });
    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot,
        conductorAgentId: 'agent-live',
      }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: 'agent-live',
        issueUrl: 'https://github.com/org/repo/issues/1',
        repoRoot,
        profile: { workers: [] },
        openQuestions: [question],
        sequence: 1,
        workers: {},
        harnessSocketPath: server.socketPath,
        updatedAt: Date.now(),
      },
    );

    const listed = await createListLiveOpenQuestionsTool(repoRoot).execute({
      conductorAgentId: 'agent-live',
    });
    expect(listed.structuredContent).toMatchObject({
      questions: [
        expect.objectContaining({
          id: question.id,
          question: question.question,
          responseType: question.responseType,
        }),
      ],
    });

    const lastMessage = await createGetLastConductorMessageTool(
      repoRoot,
    ).execute({
      conductorAgentId: 'agent-live',
    });
    expect(lastMessage.structuredContent).toEqual({
      message: {
        text: 'The conductor response.',
        at: 1792512003000,
        sendCount: 44,
      },
    });
    expect(JSON.parse(lastMessage.content[0]!.text)).toEqual(
      lastMessage.structuredContent,
    );

    const answered = await createAnswerLiveOpenQuestionTool(repoRoot).execute({
      conductorAgentId: 'agent-live',
      questionId: question.id,
      answer: 'yes',
    });
    expect(answered.structuredContent).toMatchObject({
      questionId: question.id,
      status: 'answered',
      answeredBy: 'operator',
      approved: true,
    });
    expect(JSON.parse(answered.content[0]!.text)).toEqual({
      question: {
        id: question.id,
        status: 'answered',
        answeredBy: 'operator',
        approved: true,
      },
    });
  });

  it('fails when no live socket is recorded instead of reading the YAML snapshot', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-offline-'));
    await saveSessionSidecar(
      sessionSidecarPath({
        repoRoot,
        conductorAgentId: 'agent-offline',
      }),
      {
        version: SESSION_SIDECAR_VERSION,
        conductorAgentId: 'agent-offline',
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: Date.now(),
      },
    );

    await expect(
      createListLiveOpenQuestionsTool(repoRoot).execute({
        conductorAgentId: 'agent-offline',
      }),
    ).rejects.toThrow('has no recorded live control socket');
    await expect(
      createGetLastConductorMessageTool(repoRoot).execute({
        conductorAgentId: 'agent-offline',
      }),
    ).rejects.toThrow('has no recorded live control socket');
  });
});
