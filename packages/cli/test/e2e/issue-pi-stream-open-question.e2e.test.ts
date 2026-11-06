import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './test-helpers.js';

const ISSUE_URL = 'https://github.com/fixture/fixture/issues/1';
const QUESTION_COUNT = 6;
const TARGET_QUESTION_ID = `inq-${QUESTION_COUNT}`;
const PRE_RESIZE_DRAFT = 'd'.repeat(80);
const POST_RESIZE_SUFFIX = '-after-resize';
const RESIZED_ANSWER = `${PRE_RESIZE_DRAFT}${POST_RESIZE_SUFFIX}`;

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

def shrink_terminal(signum, frame):
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 18, 40, 0, 0))
    try:
        os.killpg(child.pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop_child)
signal.signal(signal.SIGINT, stop_child)
signal.signal(signal.SIGUSR1, shrink_terminal)

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

interface FixtureRequest {
  messages?: Array<{ role?: string; content?: unknown; [key: string]: unknown }>;
}

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
  requests: FixtureRequest[];
}> {
  const requests: FixtureRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(body) as FixtureRequest);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (requests.length === 1) {
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({ role: 'assistant' }))}\n\n`);
        response.write(
          `data: ${JSON.stringify(
            createFixtureChatChunk({
              tool_calls: Array.from({ length: QUESTION_COUNT }, (_, index) => ({
                index,
                id: `fixture-ask-${index + 1}`,
                type: 'function',
                function: {
                  name: 'ask_human',
                  arguments: JSON.stringify({
                    question: `Choose the option for question ${index + 1}`,
                    responseType: 'choice',
                    choices: [
                      { id: 'accept', label: 'Accept' },
                      { id: 'defer', label: 'Defer' },
                    ],
                  }),
                },
              })),
            }),
          )}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify(createFixtureChatChunk({}, 'tool_calls'))}\n\n`,
        );
      } else {
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({ role: 'assistant' }))}\n\n`);
        response.write(
          `data: ${JSON.stringify(
            createFixtureChatChunk({
              content:
                requests.length === 2
                  ? 'Fixture questions are ready.'
                  : 'Fixture operator answer received.',
            }),
          )}\n\n`,
        );
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({}, 'stop'))}\n\n`);
      }

      response.write(
        `data: ${JSON.stringify({
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
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
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
    requests,
  };
}

async function waitFor(
  predicate: () => boolean,
  child: ChildProcess,
  description: string,
  timeoutMs: number,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `PTY CLI exited before ${description} (code=${child.exitCode}, signal=${child.signalCode}).\n${getOutput()}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.\n${getOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForText(
  getText: () => string,
  fragment: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    () => getText().includes(fragment),
    child,
    JSON.stringify(fragment),
    timeoutMs,
    getText,
  );
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

describe('Pi + stream issue session through a real PTY', () => {
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
      fixtureRoot = undefined;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'starts ensemble issue, processes rapid Pi questions, then accepts an answer after resize',
    async () => {
      const model = await startFixtureModelServer();
      modelServer = model.server;
      fixtureRoot = await mkdtemp(join(tmpdir(), 'e636-'));
      const repoRoot = join(fixtureRoot, 'repo');
      const agentDir = join(fixtureRoot, 'isolated-pi-user');
      const projectDir = join(repoRoot, '.ensemble', 'pi');
      const bootstrapPath = join(fixtureRoot, 'github-api-fixture.mjs');
      const profilePath = join(fixtureRoot, 'empty-workers.yaml');
      await Promise.all([
        mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
        mkdir(projectDir, { recursive: true }),
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
                  maxTokens: 512,
                },
              ],
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
        title: 'Pi stream open-question fixture',
        body: 'A real CLI, Pi, stream layout, and PTY input check.',
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
          'The Pi stream PTY fixture requires Python 3 with the standard-library pty module.',
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
          'json',
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

      const normalizedOutput = () => stripTerminalControls(output);
      await waitForText(
        normalizedOutput,
        'Choose the option for question 6',
        ptyRunner,
        30_000,
      );
      await waitFor(
        () => model.requests.length >= 2,
        ptyRunner,
        'Pi to finish its ask_human tool calls',
        30_000,
        normalizedOutput,
      );

      for (let index = 1; index < QUESTION_COUNT; index += 1) {
        ptyRunner.stdin?.write('\u001b[1;2B');
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      await waitForText(normalizedOutput, `${QUESTION_COUNT}/${QUESTION_COUNT}`, ptyRunner, 3_000);

      ptyRunner.stdin?.write(PRE_RESIZE_DRAFT);
      await new Promise((resolve) => setTimeout(resolve, 150));
      ptyRunner.kill('SIGUSR1');
      await new Promise((resolve) => setTimeout(resolve, 750));
      ptyRunner.stdin?.write(POST_RESIZE_SUFFIX);
      await waitForText(normalizedOutput, POST_RESIZE_SUFFIX, ptyRunner, 3_000);
      ptyRunner.stdin?.write('\r');
      await waitFor(
        () =>
          model.requests.some((request) =>
            JSON.stringify(request).includes(RESIZED_ANSWER),
          ),
        ptyRunner,
        'the post-resize answer to reach Pi',
        30_000,
        normalizedOutput,
      );
      const answerRequest = model.requests.find((request) =>
        JSON.stringify(request).includes(RESIZED_ANSWER),
      );
      expect(JSON.stringify(answerRequest)).toContain(TARGET_QUESTION_ID);

      ptyRunner.stdin?.write('/exit');
      await waitForText(normalizedOutput, '> /exit', ptyRunner, 3_000);
      ptyRunner.stdin?.write('\r');
      await waitForText(normalizedOutput, '"stopReason": "completed"', ptyRunner, 30_000);
      const exit = await waitForProcessExit(ptyRunner, 3_000);
      expect(exit).toEqual({ code: 0, signal: null });
    },
    60_000,
  );
});
