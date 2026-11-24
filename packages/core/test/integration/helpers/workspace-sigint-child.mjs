// Run against the built core so the parent can deliver a real OS signal to an
// isolated process. CI builds the packages before running integration tests.
import { AcpBridge } from '../../../dist/acp/acp-bridge.js';
import { AcpClient } from '../../../dist/acp/acp-client.js';
import { startFakeAcpServer } from '../../../dist/acp/testing/fake-acp-server.js';
import { createInProcessStreamPair } from '../../../dist/acp/testing/stream-pair.js';
import { runConductorSession } from '../../../dist/conductor/conductor-session.js';

const [phase, repoRoot, noteId = '', priorSessionId = ''] = process.argv.slice(2);
const streams = createInProcessStreamPair();
const loads = [];
const prompts = [];
startFakeAcpServer({
  readable: streams.serverReadable,
  writable: streams.serverWritable,
  initialSessions: priorSessionId ? [priorSessionId] : [],
  onLoadSession: (params) => loads.push(params),
  onPrompt: async ({ sessionId }) => {
    prompts.push(sessionId);
    return { stopReason: 'end_turn' };
  },
});
const client = AcpClient.create({ readable: streams.clientReadable, writable: streams.clientWritable });
await client.connect();
const bridge = AcpBridge.fromClient(client);
let savedNoteId = noteId;
let readMemo;
let tools;
const makeAgent = async (options, resumeOptions) => {
  tools = (resumeOptions ?? options).customTools;
  return {
    agentId: 'sigint-test-agent',
    send: async () => {
      if (phase === 'initial' && !savedNoteId) {
        const result = await tools.create_note.execute({ summary: 'SIGINT test' });
        savedNoteId = JSON.parse(result.content[0].text).noteId;
        await tools.push_memo.execute({ noteId: savedNoteId, body: 'before SIGINT' });
      } else if (phase === 'resume') {
        const result = await tools.read_note.execute({ noteId: savedNoteId });
        readMemo = JSON.parse(result.content[0].text).memos[0].body;
        await tools.push_memo.execute({ noteId: savedNoteId, body: 'after resume' });
      }
      return { runId: phase, status: 'finished', result: 'ok' };
    },
    close: async () => {},
    closeForResume: async () => {},
    getUsage: async () => ({}),
  };
};
const result = await runConductorSession({
  issueUrl: 'workspace://sigint-workspace',
  repoRoot,
  conductorCwd: repoRoot,
  profile: {
    conductor: { backend: 'cursor' },
    agents: { ping: { prompt: { instructions: ['Reply pong.'] } } },
    workers: [{ name: 'ping-1', kind: 'ping' }],
  },
  conductorAgentFactory: { create: makeAgent, resume: makeAgent },
  defaultAcp: { defaultAcpCommand: process.execPath },
  connectAcp: async () => bridge,
  ownsWorkerAcpConnections: false,
  maxTurns: 3,
  ...(phase === 'initial'
    ? { briefText: 'Investigate', waitForOperatorExit: true, bindOperatorInput: () => {}, onPostLoopWait: () => process.send({ type: 'ready', noteId: savedNoteId, prompts }) }
    : { resumeAgentId: 'sigint-test-agent' }),
});
process.send({ type: 'result', stopReason: result.stopReason, noteId: savedNoteId, loads, prompts, readMemo }, () => process.exit(0));
