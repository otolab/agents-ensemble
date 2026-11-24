import {
  CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  sendOpenQuestionControlRequest,
  userSessionSnapshotPaths,
  type OpenQuestionControlConductorMessage,
  type SessionObservationSnapshot,
  type LocatedSessionResumeStore,
  type SessionResumeStore,
} from '@agents-ensemble/core/operator-runtime';
import type { OperatorSessionLiveStatus } from './types.js';

async function readConductorMessages(
  socketPath: string,
  params: {
    limit: number;
    order: 'asc' | 'desc';
    after?: number;
  },
): Promise<{
  messages: OpenQuestionControlConductorMessage[];
  hasMore: boolean;
}> {
  return sendOpenQuestionControlRequest(socketPath, {
    method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
    params,
  });
}

export async function readConductorMessageBaseline(socketPath: string): Promise<number> {
  try {
    const baseline = await readConductorMessages(socketPath, {
      limit: 1,
      order: 'desc',
    });
    return baseline.messages[0]?.sendCount ?? 0;
  } catch (error) {
    const oversizedSendCount = oversizedConductorMessageSendCount(error);
    if (oversizedSendCount !== undefined) return oversizedSendCount;
    throw error;
  }
}

export async function readConductorMessagePages(
  socketPath: string,
  cursor: number,
): Promise<{
  messages: OpenQuestionControlConductorMessage[];
  oversizedSendCounts: number[];
  cursor: number;
  responseSizeError?: OpenQuestionControlRemoteError;
}> {
  const messages: OpenQuestionControlConductorMessage[] = [];
  const oversizedSendCounts: number[] = [];
  let after = cursor;
  let limit = CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT;

  while (true) {
    let page: Awaited<ReturnType<typeof readConductorMessages>>;
    try {
      page = await readConductorMessages(socketPath, {
        limit,
        order: 'asc',
        after,
      });
    } catch (error) {
      if (!isConductorMessageResponseTooLarge(error)) throw error;
      if (limit === 1) {
        const oversizedSendCount =
          oversizedConductorMessageSendCount(error);
        if (
          oversizedSendCount === undefined ||
          oversizedSendCount <= after
        ) {
          return {
            messages,
            oversizedSendCounts,
            cursor: after,
            responseSizeError: error,
          };
        }
        oversizedSendCounts.push(oversizedSendCount);
        after = oversizedSendCount;
        limit = CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT;
        continue;
      }
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }

    const nextMessages = page.messages
      .filter((message) => message.sendCount > after)
      .sort((left, right) => left.sendCount - right.sendCount);
    if (nextMessages.length === 0) {
      return { messages, oversizedSendCounts, cursor: after };
    }
    messages.push(...nextMessages);
    after = nextMessages.at(-1)!.sendCount;
    if (!page.hasMore) {
      return { messages, oversizedSendCounts, cursor: after };
    }
  }
}

function isConductorMessageResponseTooLarge(
  error: unknown,
): error is OpenQuestionControlRemoteError {
  return (
    error instanceof OpenQuestionControlRemoteError &&
    error.rpcCode === -32603 &&
    error.message === 'Response is too large.'
  );
}

function oversizedConductorMessageSendCount(
  error: unknown,
): number | undefined {
  if (
    !isConductorMessageResponseTooLarge(error) ||
    !error.data ||
    !('oversizedSendCount' in error.data)
  ) {
    return undefined;
  }
  return error.data.oversizedSendCount;
}

export function formatConductorMessageReport(
  resumeStore: SessionResumeStore,
  message: OpenQuestionControlConductorMessage,
): string {
  return [
    `対象: ${resumeStore.issueUrl} (${resumeStore.conductorAgentId})`,
    `sendCount: ${message.sendCount}`,
    `at: ${new Date(message.at).toISOString()}`,
    ...(message.dispatchSource
      ? [`dispatchSource: ${message.dispatchSource}`]
      : []),
    '',
    '#### inbound',
    '',
    message.inbound,
    '',
    '#### response',
    '',
    message.text,
  ].join('\n');
}

export async function readObservation(
  repoRoot: string,
  located: LocatedSessionResumeStore,
): Promise<{
  snapshot: SessionObservationSnapshot;
  source: 'uds' | 'resume_store';
  connectivity: OperatorSessionLiveStatus['connectivity'];
  checkedAt: number;
}> {
  // The snapshot can already be old when the response or later store reads
  // finish. Use the request start as a conservative freshness boundary.
  const checkedAt = Date.now();
  const { resumeStore } = located;
  if (resumeStore.harnessSocketPath) {
    try {
      return {
        snapshot: await sendOpenQuestionControlRequest<SessionObservationSnapshot>(
          resumeStore.harnessSocketPath,
          { method: OPEN_QUESTION_CONTROL_METHODS.observe },
        ),
        source: 'uds',
        connectivity: 'reachable',
        checkedAt,
      };
    } catch (error) {
      if (
        !(error instanceof OpenQuestionControlTransportError) &&
        !(
          error instanceof OpenQuestionControlRemoteError &&
          error.rpcCode === -32601
        )
      ) {
        throw error;
      }
      // A recorded socket path is only an index. When it is stale/unreachable,
      // or an older server does not implement snapshots, mark persisted data
      // as the observation source instead of presenting it as live.
      const connectivity =
        error instanceof OpenQuestionControlTransportError && error.reason === 'connection'
          ? 'unreachable'
          : 'unknown';
      const questions = await loadPersistedOpenQuestions(
        repoRoot,
        located,
      );
      const sessionState = await loadPersistedSessionState(
        repoRoot,
        located,
      );
      return {
        snapshot: {
          sequence: questions?.sequence ?? resumeStore.sequence,
          openQuestions: questions?.openQuestions ?? resumeStore.openQuestions,
          ...(sessionState ? { sessionState } : {}),
        },
        source: 'resume_store',
        connectivity,
        checkedAt,
      };
    }
  }
  const questions = await loadPersistedOpenQuestions(
    repoRoot,
    located,
  );
  const sessionState = await loadPersistedSessionState(
    repoRoot,
    located,
  );
  return {
    snapshot: {
      sequence: questions?.sequence ?? resumeStore.sequence,
      openQuestions: questions?.openQuestions ?? resumeStore.openQuestions,
      ...(sessionState ? { sessionState } : {}),
    },
    source: 'resume_store',
    connectivity: 'unknown',
    checkedAt,
  };
}

async function loadPersistedOpenQuestions(
  repoRoot: string,
  located: LocatedSessionResumeStore,
) {
  const paths = userSessionSnapshotPaths(repoRoot, located, 'open-questions');
  for (const path of paths) {
    const snapshot = await loadOpenQuestionsStore(path);
    if (snapshot) return snapshot;
  }
  return undefined;
}

async function loadPersistedSessionState(
  repoRoot: string,
  located: LocatedSessionResumeStore,
) {
  const paths = userSessionSnapshotPaths(repoRoot, located, 'session-state');
  for (const path of paths) {
    const state = await loadSessionStateStore(path);
    if (state) return state;
  }
  return undefined;
}
