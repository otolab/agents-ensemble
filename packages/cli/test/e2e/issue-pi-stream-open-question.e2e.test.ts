import { createServer, type Server } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './test-helpers.js';

const ISSUE_URL = 'https://github.com/fixture/fixture/issues/1';
const TARGET_QUESTION_ID = 'inq-1';
const INITIAL_ANSWER =
  '日本語入力の折り返しを確認するための試験文です。'.repeat(2) +
  '\n回答欄を編集中にセッション状態が更新されても、この下書きが残ることを確認します。';
const POST_RESIZE_SUFFIX = '\n幅を変えた後にも日本語で追記します。';
const SHIFT_ENTER = '\u001b[27;2;13~';
const ACCUMULATED_HISTORY_SIZE = 512;
const EVENT_BURST_SIZE = 512;

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
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 25, 80, 0, 0))
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

function fixtureRequestContains(request: FixtureRequest, fragment: string): boolean {
  const serializedRequest = JSON.stringify(request);
  const serializedFragments = [
    fragment,
    fragment.replace(/\n/g, '\\n'),
    fragment.replace(/\n/g, '\\\\n'),
  ];
  return serializedFragments.some((serialized) =>
    serializedRequest.includes(serialized),
  );
}

function fixtureRequestHasQuestionAnswer(
  request: FixtureRequest,
  answerFragments: readonly string[],
): boolean {
  return (
    request.messages?.some((message) => {
      const candidateRequest = { messages: [message] };
      return (
        fixtureRequestContains(
          candidateRequest,
          `【open question 回答】${TARGET_QUESTION_ID}:`,
        ) &&
        answerFragments.every((fragment) =>
          fixtureRequestContains(candidateRequest, fragment),
        )
      );
    }) ?? false
  );
}

function createFixtureToolCall(
  index: number,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    index,
    id: `fixture-tool-${index}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function countOccurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

// This sends UTF-8 text after composition has been committed. The PTY test
// does not simulate an operating system or terminal emulator's IME UI.
function writeCommittedText(child: ChildProcess, value: string): void {
  if (!child.stdin || child.stdin.destroyed) {
    throw new Error('The PTY input stream is not available.');
  }
  child.stdin.write(value, 'utf8');
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
  releaseEventBurst: () => void;
}> {
  const requests: FixtureRequest[] = [];
  let releaseEventBurst: (() => void) | undefined;
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
    request.on('end', async () => {
      requests.push(JSON.parse(body) as FixtureRequest);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (requests.length === 1) {
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({ role: 'assistant' }))}\n\n`);
        const historyEvents = Array.from(
          { length: ACCUMULATED_HISTORY_SIZE },
          (_, index) =>
            createFixtureToolCall(
              index,
              'set_dispatch_hold',
              { hold: index % 2 === 0 },
            ),
        );
        const initialToolCalls = [
          ...historyEvents,
          createFixtureToolCall(ACCUMULATED_HISTORY_SIZE, 'set_dispatch_hold', {
            hold: true,
          }),
          createFixtureToolCall(ACCUMULATED_HISTORY_SIZE + 1, 'ask_human', {
            question: '回答欄の入力と表示を確認してください。',
            responseType: 'text',
          }),
        ];
        response.write(
          `data: ${JSON.stringify(createFixtureChatChunk({ tool_calls: initialToolCalls }))}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify(createFixtureChatChunk({}, 'tool_calls'))}\n\n`,
        );
      } else if (requests.length === 2) {
        await new Promise<void>((resolve) => {
          releaseEventBurst = resolve;
        });
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({ role: 'assistant' }))}\n\n`);
        response.write(
          `data: ${JSON.stringify(
            createFixtureChatChunk({
              tool_calls: Array.from({ length: EVENT_BURST_SIZE }, (_, index) =>
                createFixtureToolCall(index, 'set_dispatch_hold', {
                  hold: index % 2 !== 0,
                }),
              ),
            }),
          )}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify(createFixtureChatChunk({}, 'tool_calls'))}\n\n`,
        );
      } else if (requests.length === 3) {
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({ role: 'assistant' }))}\n\n`);
        response.write(
          `data: ${JSON.stringify(
            createFixtureChatChunk({ content: 'Fixture event burst finished.' }),
          )}\n\n`,
        );
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({}, 'stop'))}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify(createFixtureChatChunk({ role: 'assistant' }))}\n\n`);
        response.write(
          `data: ${JSON.stringify(
            createFixtureChatChunk({ content: 'Fixture operator answer received.' }),
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
    releaseEventBurst() {
      if (!releaseEventBurst) {
        throw new Error('The Pi event-burst response is not waiting to be released');
      }
      releaseEventBurst();
      releaseEventBurst = undefined;
    },
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
      throw new Error(
        `Timed out waiting for ${description}.\n${getOutput().slice(-20_000)}`,
      );
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
    'keeps committed multiline Japanese input through Pi events and PTY resize',
    async () => {
      const model = await startFixtureModelServer();
      modelServer = model.server;
      fixtureRoot = await mkdtemp(join(tmpdir(), 'e636-'));
      const repoRoot = join(fixtureRoot, 'repo');
      const agentDir = join(fixtureRoot, 'isolated-pi-user');
      const projectDir = join(repoRoot, '.ensemble', 'pi');
      const bootstrapPath = join(fixtureRoot, 'github-api-fixture.mjs');
      const profilePath = join(fixtureRoot, 'one-idle-worker.yaml');
      const fakeAcpAgentPath = join(fixtureRoot, 'fake-acp-agent.cjs');
      await Promise.all([
        mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
        mkdir(projectDir, { recursive: true }),
        mkdir(agentDir, { recursive: true }),
      ]);
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoRoot]);
      execFileSync(
        'git',
        [
          '-C',
          repoRoot,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '--quiet',
          '-m',
          'fixture',
        ],
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
          '  worktree: in_repo',
          '  postLoop:',
          '    wait: true',
          'tui:',
          '  layout: stream',
          '  forceHyperlink: off',
          '',
        ].join('\n'),
      );
      await writeFile(
        profilePath,
        'workers:\n  - name: implementer\n    kind: implementer\n',
      );
      await writeFile(
        fakeAcpAgentPath,
        String.raw`
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: 1,
          agentCapabilities: { session: {} },
          agentInfo: { name: 'issue-636-fixture-worker', version: '1.0.0' },
        }
      : message.method === 'session/new'
        ? { sessionId: 'issue-636-fixture-worker-session' }
        : message.method === 'session/prompt'
          ? { stopReason: 'end_turn' }
          : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
setInterval(() => {}, 60_000);
`,
      );
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
        COLUMNS: '80',
        LINES: '25',
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
          '--default-acp-command',
          process.execPath,
          '--default-acp-arg',
          fakeAcpAgentPath,
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
        '回答欄の入力と表示を確認してください。',
        ptyRunner,
        30_000,
      );
      await waitForText(normalizedOutput, '1/1', ptyRunner, 3_000);
      await waitForText(normalizedOutput, 'implementer: idle', ptyRunner, 10_000);
      await waitForText(normalizedOutput, 'dispatch hold enabled', ptyRunner, 3_000);
      await waitFor(
        () => model.requests.length >= 2,
        ptyRunner,
        'Pi to wait for the gated event-burst response',
        30_000,
        normalizedOutput,
      );

      const [initialFirstLine, initialSecondLine] = INITIAL_ANSWER.split('\n');
      if (!initialFirstLine || !initialSecondLine) {
        throw new Error('The Japanese Open Question fixture answer must have two lines.');
      }
      writeCommittedText(ptyRunner, initialFirstLine);
      await waitForText(
        normalizedOutput,
        initialFirstLine.slice(-4),
        ptyRunner,
        3_000,
      );
      ptyRunner.stdin?.write(SHIFT_ENTER);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const secondLineCharacters = Array.from(initialSecondLine);
      const secondLineSplit = Math.floor(secondLineCharacters.length / 2);
      const committedPrefix = secondLineCharacters.slice(0, secondLineSplit).join('');
      writeCommittedText(ptyRunner, committedPrefix);
      await waitForText(
        normalizedOutput,
        'セッション状態が更新',
        ptyRunner,
        3_000,
      );
      const enabledHoldLogsBeforeResize = countOccurrences(
        normalizedOutput(),
        'dispatch hold enabled',
      );
      model.releaseEventBurst();
      ptyRunner.kill('SIGUSR1');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const committedSuffix = secondLineCharacters.slice(secondLineSplit).join('');
      writeCommittedText(ptyRunner, committedSuffix);
      await waitForText(
        normalizedOutput,
        committedSuffix.slice(-4),
        ptyRunner,
        3_000,
      );
      await waitFor(
        () => model.requests.length >= 3,
        ptyRunner,
        'Pi to finish the repeated dispatch-hold event burst',
        30_000,
        normalizedOutput,
      );
      const enabledHoldLogsAfterResize = countOccurrences(
        normalizedOutput(),
        'dispatch hold enabled',
      );
      expect(enabledHoldLogsAfterResize - enabledHoldLogsBeforeResize).toBeGreaterThan(
        EVENT_BURST_SIZE / 4,
      );

      const answerFragments = [
        initialFirstLine,
        initialSecondLine,
        POST_RESIZE_SUFFIX.slice(1),
      ];
      const postResizeLine = POST_RESIZE_SUFFIX.slice(1);
      ptyRunner.stdin?.write(SHIFT_ENTER);
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeCommittedText(ptyRunner, postResizeLine);
      await waitForText(
        normalizedOutput,
        postResizeLine.slice(-4),
        ptyRunner,
        3_000,
      );
      ptyRunner.stdin?.write('\r');
      await waitFor(
        () =>
          model.requests.some((request) =>
            fixtureRequestHasQuestionAnswer(request, answerFragments),
          ),
        ptyRunner,
        'Pi to send the submitted answer with its question ID',
        30_000,
        () =>
          JSON.stringify(
            {
              requests: model.requests.map((request, index) => ({
                index,
                messageCount: request.messages?.length ?? 0,
                hasQuestionAnswer: fixtureRequestHasQuestionAnswer(
                  request,
                  answerFragments,
                ),
                hasAnySubmittedFragment: answerFragments.some((fragment) =>
                  fixtureRequestContains(request, fragment),
                ),
                answerFragmentPresence: answerFragments.map((fragment) =>
                  fixtureRequestContains(request, fragment),
                ),
                hasExpectedEnvelope: fixtureRequestContains(
                  request,
                  `【open question 回答】${TARGET_QUESTION_ID}:`,
                ),
              })),
            },
          ),
      );
      const answerRequest = model.requests.find((request) =>
        fixtureRequestHasQuestionAnswer(request, answerFragments),
      );
      const answerMessage = answerRequest?.messages?.find((message) => {
        return fixtureRequestHasQuestionAnswer(
          { messages: [message] },
          answerFragments,
        );
      });
      const requestSummaries = model.requests.map((request, index) => ({
        index,
        messageCount: request.messages?.length ?? 0,
        hasQuestionAnswer: fixtureRequestHasQuestionAnswer(
          request,
          answerFragments,
        ),
      }));
      expect(answerMessage, JSON.stringify(requestSummaries)).toBeDefined();

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
