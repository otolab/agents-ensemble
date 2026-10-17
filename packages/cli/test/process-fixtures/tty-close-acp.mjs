import { createInterface } from 'node:readline';

let workerSessionId = 'tty-worker-session';

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handleMessage(message) {
  if (!('id' in message)) {
    // Leave session/cancel unanswered so /close must tear down an in-flight
    // prompt through the production ACP child-process close path.
    return;
  }

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: 'tty-close-process-fixture', version: '1' },
        agentCapabilities: {},
      });
      return;
    case 'session/new':
      workerSessionId = 'tty-worker-session';
      respond(message.id, { sessionId: workerSessionId });
      return;
    case 'session/load':
      workerSessionId = message.params.sessionId;
      respond(message.id, {});
      return;
    case 'session/prompt':
      process.stderr.write(
        `TTY_CLOSE_ACP_PROMPT pid=${process.pid}\n`,
      );
      return;
    default:
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unknown method: ${message.method}` },
        })}\n`,
      );
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  handleMessage(JSON.parse(line));
});
input.on('close', () => {
  process.exit(0);
});
