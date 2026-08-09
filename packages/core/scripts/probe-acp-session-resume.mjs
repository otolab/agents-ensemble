/**
 * Probe ACP session restore methods after process restart.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

let nextId = 1;
const pending = new Map();

function createPeer(readable, writable) {
  const rl = createInterface({ input: readable });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) {
      const resolve = pending.get(msg.id);
      if (!resolve) return;
      pending.delete(msg.id);
      if (msg.error) resolve.reject(new Error(JSON.stringify(msg.error)));
      else resolve.resolve(msg.result);
      return;
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writable.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() {
      rl.close();
      writable.end();
    },
  };
}

async function connectAgent(cwd) {
  const child = spawn('agent', ['acp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const peer = createPeer(child.stdout, child.stdin);
  await peer.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'probe-acp-session-resume', version: '0.0.0' },
  });
  await peer.request('authenticate', { methodId: 'cursor_login' });
  return { peer, child };
}

async function childExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => child.kill('SIGTERM'), 2000);
  });
}

async function main() {
  const cwd = process.cwd();
  const first = await connectAgent(cwd);
  const sessionId = (
    await first.peer.request('session/new', { cwd, mcpServers: [] })
  ).sessionId;
  console.log('SESSION_ID', sessionId);

  await first.peer.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: alpha' }],
  });

  first.peer.close();
  await childExit(first.child);
  console.log('--- process restarted ---');

  const second = await connectAgent(cwd);

  for (const method of ['session/resume', 'session/load']) {
    try {
      const result = await second.peer.request(method, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      console.log(`${method}_OK`, JSON.stringify(result));
      const prompt = await second.peer.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with exactly: beta' }],
      });
      console.log(`${method}_PROMPT_OK`, JSON.stringify(prompt));
    } catch (error) {
      console.log(`${method}_FAILED`, error.message);
    }
  }

  second.peer.close();
  await childExit(second.child);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
