import { AcpBridge } from '../../../src/acp/acp-bridge.js';
import { AcpClient } from '../../../src/acp/acp-client.js';
import {
  startFakeAcpServer,
  type FakeAcpPromptResult,
} from '../../../src/acp/testing/fake-acp-server.js';
import { createInProcessStreamPair } from '../../../src/acp/testing/stream-pair.js';

export const PING_SYSTEM_PROMPT =
  'これは接続テストです。調査・編集はせず、応答に pong とだけ含めて終了してください。';

export interface InProcessAcpBridgeOptions {
  /** Fake ACP が session/prompt 前に session/request_permission を送る */
  requestPermissionOnPrompt?: boolean;
}

export async function createInProcessAcpBridge(
  onPrompt?: (params: {
    sessionId: string;
    prompt: unknown;
    notify: (method: string, params: unknown) => void;
  }) => FakeAcpPromptResult | Promise<FakeAcpPromptResult>,
  options?: InProcessAcpBridgeOptions,
): Promise<AcpBridge> {
  const streams = createInProcessStreamPair();
  startFakeAcpServer({
    readable: streams.serverReadable,
    writable: streams.serverWritable,
    requestPermissionOnPrompt: options?.requestPermissionOnPrompt,
    onPrompt: onPrompt ?? (async ({ notify, sessionId }) => {
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pong' },
        },
      });
      return { stopReason: 'end_turn' };
    }),
  });

  const client = AcpClient.create({
    readable: streams.clientReadable,
    writable: streams.clientWritable,
  });
  await client.connect();
  return AcpBridge.fromClient(client);
}

export const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
} as const;

export const TEST_WORKTREE = {
  path: '/tmp/ensemble-integration/issue-1',
  branch: 'ensemble/issue-1',
  issue: TEST_ISSUE,
} as const;
