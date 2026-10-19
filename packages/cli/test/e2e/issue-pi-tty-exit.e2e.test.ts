import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './test-helpers.js';

const ISSUE_URL = 'https://github.com/fixture/fixture/issues/1';
const POST_LOOP_HINT =
  '追加指示 · /reconnect · /close 保存して閉じる · /exit 掃除して終了';
const SUMMARY_PREFIX = 'セッション終了 (';

const PYTHON_PTY_RUNNER = String.raw`
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master_fd, slave_fd = pty.openpty()
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
child = subprocess.Popen(
    sys.argv[1:],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=True,
    start_new_session=True,
)
os.close(slave_fd)
input_open = True

def stop_child(signum, frame):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    os._exit(128 + signum)

signal.signal(signal.SIGTERM, stop_child)
signal.signal(signal.SIGINT, stop_child)

while True:
    read_fds = [master_fd]
    if input_open:
        read_fds.append(sys.stdin.fileno())
    ready, _, _ = select.select(read_fds, [], [], 0.05)

    if master_fd in ready:
        try:
            chunk = os.read(master_fd, 8192)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            os.write(sys.stdout.fileno(), chunk)

    if input_open and sys.stdin.fileno() in ready:
        chunk = os.read(sys.stdin.fileno(), 8192)
        if chunk:
            os.write(master_fd, chunk)
        else:
            input_open = False

    if child.poll() is not None:
        os.set_blocking(master_fd, False)
        while True:
            try:
                chunk = os.read(master_fd, 8192)
            except BlockingIOError:
                break
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            os.write(sys.stdout.fileno(), chunk)
        break

os.close(master_fd)
sys.exit(child.returncode)
`;

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function createFixtureChatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: 'fixture-completion',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function startFixtureModelServer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: number;
}> {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    request.resume();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const chunk of [
      createFixtureChatChunk({ role: 'assistant' }),
      createFixtureChatChunk({ content: 'Fixture session finished.' }),
      createFixtureChatChunk({}, 'stop'),
      {
        id: 'fixture-completion',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1_000),
        model: 'fixture-model',
        choices: [],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      },
    ]) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture model server did not bind a TCP port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
  };
}

async function waitForText(
  getText: () => string,
  fragment: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  const current = getText();
  if (current.includes(fragment)) return current;

  return await new Promise((resolve, reject) => {
    const output = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (getText().includes(fragment)) {
        cleanup();
        resolve(getText());
      } else if (text.length === 0) {
        return;
      }
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `PTY CLI exited before ${JSON.stringify(fragment)} (code=${code}, signal=${signal}).\n${getText()}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${JSON.stringify(fragment)}.\n${getText()}`,
        ),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', output);
      child.stderr?.off('data', output);
      child.off('exit', exited);
    };
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);
    child.once('exit', exited);
  });
}

async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`PTY CLI did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', exited);
    };
    child.once('exit', exited);
  });
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('Pi conductor TTY /exit process lifecycle', () => {
  let fixtureRoot: string | undefined;
  let modelServer: Server | undefined;
  let ptyRunner: ChildProcess | undefined;

  afterEach(async () => {
    if (ptyRunner && ptyRunner.exitCode === null && ptyRunner.signalCode === null) {
      ptyRunner.kill('SIGTERM');
      await waitForProcessExit(ptyRunner, 2_000).catch(() => {
        ptyRunner?.kill('SIGKILL');
      });
    }
    if (modelServer?.listening) {
      await new Promise<void>((resolve) => modelServer!.close(() => resolve()));
    }
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'naturally exits after TTY /exit and reaps its Pi stdio MCP child',
    async () => {
      const model = await startFixtureModelServer();
      modelServer = model.server;
      fixtureRoot = await mkdtemp(join(tmpdir(), 'ensemble-pi-tty-exit-'));
      const repoRoot = join(fixtureRoot, 'repo');
      const agentDir = join(fixtureRoot, 'isolated-pi-user');
      const projectDir = join(repoRoot, '.ensemble', 'pi');
      const pidFile = join(fixtureRoot, 'mcp-pids');
      const bootstrapPath = join(fixtureRoot, 'github-api-fixture.mjs');
      const profilePath = join(fixtureRoot, 'empty-workers.yaml');
      await Promise.all([
        mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
        mkdir(projectDir, { recursive: true }),
        mkdir(join(repoRoot, '.agents'), { recursive: true }),
        mkdir(agentDir, { recursive: true }),
      ]);

      await writeFile(
        join(repoRoot, '.ensemble', 'config.yaml'),
        [
          'conductor:',
          '  backend: pi',
          `  pi:\n    agentDir: ${JSON.stringify(agentDir)}`,
          `    projectDir: ${JSON.stringify(projectDir)}`,
          'github:',
          '  auth:',
          '    allowGhAuthTokenFallback: false',
          '  monitor:',
          '    enabled: false',
          'session:',
          '  worktree: in_repo',
          '  postLoop:',
          '    wait: true',
          'tui:',
          '  layout: stream',
          '  forceHyperlink: off',
          '',
        ].join('\n'),
      );
      await writeFile(profilePath, 'workers: []\n');
      await writeFile(
        join(projectDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'fixture',
          defaultModel: 'fixture-model',
        }),
      );
      await writeFile(
        join(projectDir, 'models.json'),
        JSON.stringify({
          providers: {
            fixture: {
              api: 'openai-completions',
              baseUrl: model.baseUrl,
              apiKey: 'fixture-local-only',
              models: [
                {
                  id: 'fixture-model',
                  name: 'Local fixture model',
                  contextWindow: 8_192,
                  maxTokens: 128,
                },
              ],
            },
          },
        }),
      );

      const mcpServerScript = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.MCP_PID_FILE, String(process.pid) + '\n');
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'tty-exit-fixture', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: [] });
  } else if (message.method === 'resources/list') {
    send(message.id, { resources: [] });
  } else if (message.method === 'prompts/list') {
    send(message.id, { prompts: [] });
  } else if (message.method === 'ping') {
    send(message.id, {});
  } else {
    fail(message.id, 'method not found');
  }
});
setInterval(() => {}, 60_000);
`;
      await writeFile(
        join(repoRoot, '.agents', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            ttyExitFixture: {
              type: 'stdio',
              command: process.execPath,
              args: ['-e', mcpServerScript],
              env: { MCP_PID_FILE: pidFile },
            },
          },
        }),
      );

      await writeFile(
        bootstrapPath,
        `
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl);
  if (url.hostname === 'api.github.com') {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
      throw new Error('The PTY fixture blocks GitHub API writes.');
    }
    if (url.pathname === '/repos/fixture/fixture/issues/1') {
      return Response.json({
        title: 'PTY teardown fixture',
        body: 'A local end-to-end process teardown check.',
        state: 'open',
        labels: [],
      });
    }
    if (url.pathname === '/repos/fixture/fixture/issues/1/comments') {
      return Response.json([]);
    }
    if (url.pathname === '/user') {
      return Response.json({ login: 'fixture-operator' });
    }
    throw new Error('Unexpected GitHub fixture request: ' + url);
  }
  if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
  throw new Error('The PTY fixture blocks external network access: ' + url);
};
`,
      );

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: join(fixtureRoot, 'home'),
        USERPROFILE: join(fixtureRoot, 'home'),
        TMPDIR: fixtureRoot,
        TMP: fixtureRoot,
        TEMP: fixtureRoot,
        TERM: 'xterm-256color',
        COLUMNS: '100',
        LINES: '30',
        NO_COLOR: '1',
        GITHUB_TOKEN: 'fixture-only-token',
        MCP_PID_FILE: pidFile,
        LC_ALL: 'C.UTF-8',
      };
      await mkdir(env.HOME!, { recursive: true });
      const pythonExecutable = [
        process.env.PYTHON3,
        process.env.PYTHON,
        '/usr/bin/python3',
        '/usr/local/bin/python3',
        '/opt/homebrew/bin/python3',
        '/opt/homebrew/opt/python@3.14/bin/python3.14',
      ].find((candidate) => candidate && existsSync(candidate));
      if (!pythonExecutable) {
        throw new Error(
          'The Pi TTY e2e fixture requires Python 3 with the standard-library pty module.',
        );
      }

      ptyRunner = spawn(
        pythonExecutable,
        [
          '-c',
          PYTHON_PTY_RUNNER,
          process.execPath,
          '--import',
          bootstrapPath,
          CLI_ENTRY,
          'issue',
          ISSUE_URL,
          '--repo-root',
          repoRoot,
          '--conductor-cwd',
          repoRoot,
          '--profile',
          profilePath,
          '--worktree',
          'in_repo',
          '--no-github-monitor',
          '--summary-format',
          'text',
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      const collectOutput = (chunk: Buffer | string) => {
        output += String(chunk);
      };
      ptyRunner.stdout?.setEncoding('utf8');
      ptyRunner.stderr?.setEncoding('utf8');
      ptyRunner.stdout?.on('data', collectOutput);
      ptyRunner.stderr?.on('data', collectOutput);

      await waitForText(
        () => stripTerminalControls(output),
        POST_LOOP_HINT,
        ptyRunner,
        30_000,
      );
      ptyRunner.stdin?.write('/exit');
      await waitForText(
        () => stripTerminalControls(output),
        'operator> /exit',
        ptyRunner,
        2_000,
      );
      ptyRunner.stdin?.write('\r');

      await waitForText(
        () => stripTerminalControls(output),
        SUMMARY_PREFIX,
        ptyRunner,
        30_000,
      );
      const summarySeenAt = Date.now();
      const exit = await waitForProcessExit(ptyRunner, 3_000);

      expect(exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - summarySeenAt).toBeLessThan(3_000);
      expect(stripTerminalControls(output)).toContain('セッション終了 (completed)');
      expect(model.requests).toBeGreaterThan(0);

      const pids = (await readFile(pidFile, 'utf8'))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(pids).toHaveLength(1);
      const deadline = Date.now() + 1_000;
      while (await processIsAlive(pids[0]!) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await processIsAlive(pids[0]!)).toBe(false);
    },
    45_000,
  );
});
