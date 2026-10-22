import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenQuestionRegistry } from '../../core/src/escalation/open-question.js';
import { recordOpenQuestionAnswer } from '../../core/src/escalation/record-open-question-answer.js';
import {
  startOpenQuestionControlServer,
  type OpenQuestionControlServer,
} from '../../core/src/session/open-question-control.js';
import {
  saveSessionResumeStore,
  sessionResumeStorePath,
  SESSION_RESUME_STORE_VERSION,
} from '../../core/src/session/session-resume-store.js';
import {
  createAnswerLiveOpenQuestionTool,
  createGetLastConductorMessageTool,
  createListConductorMessagesTool,
  createListLiveOpenQuestionsTool,
  createSendOperatorMessageTool,
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

  it('lists and answers through the socket recorded in the session resume store', async () => {
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
      listConductorMessages: () => [
        {
          text: 'The conductor response.',
          inbound: 'The full formatted inbound context.',
          at: 1792512003000,
          sendCount: 44,
          dispatchSource: 'operator',
        },
      ],
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
    await saveSessionResumeStore(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: 'agent-live',
      }),
      {
        version: SESSION_RESUME_STORE_VERSION,
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

    const messageHistory = await createListConductorMessagesTool(
      repoRoot,
    ).execute({
      conductorAgentId: 'agent-live',
      limit: 1,
      order: 'asc',
    });
    expect(messageHistory.structuredContent).toEqual({
      messages: [
        {
          text: 'The conductor response.',
          inbound: 'The full formatted inbound context.',
          at: 1792512003000,
          sendCount: 44,
          dispatchSource: 'operator',
        },
      ],
      hasMore: false,
    });
    expect(JSON.parse(messageHistory.content[0]!.text)).toEqual(
      messageHistory.structuredContent,
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
    await saveSessionResumeStore(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: 'agent-offline',
      }),
      {
        version: SESSION_RESUME_STORE_VERSION,
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
    await expect(
      createListConductorMessagesTool(repoRoot).execute({
        conductorAgentId: 'agent-offline',
      }),
    ).rejects.toThrow('has no recorded live control socket');
  });

  it('sends one operator message through the live session UDS', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-send-'));
    const sendOperatorMessage = vi.fn().mockReturnValue(true);
    server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      answerOpenQuestion: async () => {
        throw new Error('unexpected answer');
      },
      sendOperatorMessage,
    });
    await saveSessionResumeStore(
      sessionResumeStorePath({
        repoRoot,
        conductorAgentId: 'agent-send',
      }),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: 'agent-send',
        issueUrl: 'https://github.com/org/repo/issues/3',
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        harnessSocketPath: server.socketPath,
        updatedAt: Date.now(),
      },
    );

    const sendTool = createSendOperatorMessageTool(repoRoot);
    expect(sendTool.inputSchema).toMatchObject({
      properties: {
        delivery: { enum: ['idle', 'next', 'interrupt'] },
      },
    });
    const deliveries = [
      ['idle', 'idle'],
      ['next', 'next'],
      ['interrupt', 'interrupt'],
      [undefined, 'next'],
    ] as const;
    for (const [requestedDelivery, expectedDelivery] of deliveries) {
      const sent = await sendTool.execute({
        conductorAgentId: 'agent-send',
        text: `message ${expectedDelivery}`,
        ...(requestedDelivery ? { delivery: requestedDelivery } : {}),
      });
      expect(sent.structuredContent).toEqual({
        queued: true,
        delivery: expectedDelivery,
      });
    }
    expect(sendOperatorMessage.mock.calls).toEqual(
      deliveries.map(([, expectedDelivery]) => [
        { text: `message ${expectedDelivery}`, delivery: expectedDelivery },
      ]),
    );
  });
});
