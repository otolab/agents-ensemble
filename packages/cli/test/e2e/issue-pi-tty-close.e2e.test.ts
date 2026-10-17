import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './test-helpers.js';

const ISSUE_URL = 'https://github.com/fixture/fixture/issues/1';
const POST_LOOP_CLOSE_HINT =
  '追加指示 · /reconnect · /close 保存して閉じる';

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
  getRequests: () => number;
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
    getRequests: () => requests,
  };
}

async function waitForText(
  getText: () => string,
  fragment: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  if (getText().includes(fragment)) return getText();
  return await new Promise((resolve, reject) => {
    const output = () => {
      if (getText().includes(fragment)) {
        cleanup();
        resolve(getText());
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
      reject(new Error(`TTY /close CLI did not exit within ${timeoutMs}ms`));
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

async function waitForProcessToDisappear(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (await processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await processIsAlive(pid), `child process ${pid} should be reaped`).toBe(
    false,
  );
}

function parseSummary(output: string): { agentId: string; stopReason: string } {
  const normalized = stripTerminalControls(output);
  const summaryStart = /\{\s*"agentId"\s*:/.exec(normalized);
  const end = normalized.lastIndexOf('}');
  if (!summaryStart || end < summaryStart.index) {
    throw new Error(`TTY CLI did not print its JSON summary:\n${normalized}`);
  }
  return JSON.parse(normalized.slice(summaryStart.index, end + 1)) as {
    agentId: string;
    stopReason: string;
  };
}

describe('Pi conductor TTY /close process lifecycle', () => {
  let fixtureRoot: string | undefined;
  let modelServer: Server | undefined;
  const ptyRunners: ChildProcess[] = [];

  afterEach(async () => {
    for (const runner of ptyRunners.splice(0)) {
      if (runner.exitCode !== null || runner.signalCode !== null) continue;
      runner.kill('SIGTERM');
      await waitForProcessExit(runner, 2_000).catch(() => {
        runner.kill('SIGKILL');
      });
    }
    if (modelServer?.listening) {
      await new Promise<void>((resolve) => modelServer!.close(() => resolve()));
    }
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'closes a real TTY Pi + stdio MCP session and continues the saved Pi session',
    async () => {
      const model = await startFixtureModelServer();
      modelServer = model.server;
      fixtureRoot = await mkdtemp(join(tmpdir(), 'ensemble-pi-tty-close-'));
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
      execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'tty-close@example.test'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'TTY close process test'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', 'Initialize TTY close fixture'],
        { cwd: repoRoot, stdio: 'ignore' },
      );

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
          '  worktree: isolated',
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
      serverInfo: { name: 'tty-close-fixture', version: '1.0.0' },
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
            ttyCloseFixture: {
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
        title: 'TTY close fixture',
        body: 'A local end-to-end close and resume process check.',
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
          'The Pi TTY close e2e fixture requires Python 3 with the standard-library pty module.',
        );
      }

      const runTtySession = async (continuing: boolean) => {
        const cliArgs = [
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
          'isolated',
          '--no-github-monitor',
          '--summary-format',
          'json',
          ...(continuing ? ['--continue'] : []),
        ];
        const runner = spawn(
          pythonExecutable,
          [
            '-c',
            PYTHON_PTY_RUNNER,
            process.execPath,
            '--import',
            bootstrapPath,
            ...cliArgs,
          ],
          { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        ptyRunners.push(runner);
        let output = '';
        const collectOutput = (chunk: Buffer | string) => {
          output += String(chunk);
        };
        runner.stdout?.setEncoding('utf8');
        runner.stderr?.setEncoding('utf8');
        runner.stdout?.on('data', collectOutput);
        runner.stderr?.on('data', collectOutput);

        await waitForText(
          () => stripTerminalControls(output),
          POST_LOOP_CLOSE_HINT,
          runner,
          45_000,
        );
        runner.stdin?.write('/close');
        await new Promise((resolve) => setTimeout(resolve, 100));
        runner.stdin?.write('\r');
        await waitForText(
          () => stripTerminalControls(output),
          '"stopReason": "completed"',
          runner,
          15_000,
        );
        const summarySeenAt = Date.now();
        const exit = await waitForProcessExit(runner, 3_000);
        expect(Date.now() - summarySeenAt).toBeLessThan(3_000);
        expect(exit).toEqual({ code: 0, signal: null });
        return { summary: parseSummary(output) };
      };

      const firstRun = await runTtySession(false);
      expect(firstRun.summary.stopReason).toBe('completed');
      expect(model.getRequests()).toBeGreaterThanOrEqual(1);

      const sidecarDir = join(repoRoot, '.ensemble', 'sessions');
      const sidecarNames = (await readdir(sidecarDir)).filter((name) =>
        name.endsWith('.json'),
      );
      expect(sidecarNames).toEqual([`${firstRun.summary.agentId}.json`]);
      const sidecar = JSON.parse(
        await readFile(join(sidecarDir, sidecarNames[0]!), 'utf8'),
      ) as { conductorAgentId: string; conductorBackend: string };
      expect(sidecar).toMatchObject({
        conductorAgentId: firstRun.summary.agentId,
        conductorBackend: 'pi',
      });

      const firstPids = (await readFile(pidFile, 'utf8'))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(firstPids.length).toBeGreaterThan(0);
      await Promise.all(firstPids.map(waitForProcessToDisappear));

      const continuedRun = await runTtySession(true);
      expect(continuedRun.summary).toMatchObject({
        agentId: firstRun.summary.agentId,
        stopReason: 'completed',
      });
      expect(model.getRequests()).toBe(1);

      const resumedPids = (await readFile(pidFile, 'utf8'))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(resumedPids.length).toBeGreaterThan(firstPids.length);
      await Promise.all(resumedPids.map(waitForProcessToDisappear));
    },
    120_000,
  );
});
