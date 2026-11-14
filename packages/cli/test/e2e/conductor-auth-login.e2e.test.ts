import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './test-helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const PI_RUNTIME_FIXTURE = join(
  REPO_ROOT,
  'packages/core/test/fixtures/fake-pi-oauth-runtime.mjs',
);
const CURSOR_LOGIN_FIXTURE = join(
  REPO_ROOT,
  'packages/core/test/fixtures/fake-cursor-sdk-login.mjs',
);
const MANUAL_CODE = 'fixture-authorization-code';
const MANUAL_CODE_PROMPT = 'Paste the authorization code (input hidden): ';

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

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function collectProcess(
  child: ChildProcess,
  options: {
    timeoutMs?: number;
    onStdout?: (text: string) => void;
  } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      reject(
        new Error(
          `CLI auth fixture timed out after ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(stdout);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function createLoginFixture(
  backend: 'pi' | 'cursor',
): Promise<{ root: string; repoRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), `ensemble-${backend}-login-e2e-`));
  const repoRoot = join(root, 'repo');
  const home = join(root, 'home');
  const userRoot = join(root, 'ensemble-user');
  const agentDir = join(root, 'pi-user');
  const resultPath = join(root, 'login-result.json');
  await Promise.all([
    mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(userRoot, { recursive: true }),
    ...(backend === 'pi' ? [mkdir(agentDir, { recursive: true })] : []),
  ]);
  await writeFile(
    join(repoRoot, '.ensemble', 'config.yaml'),
    [
      'conductor:',
      `  backend: ${backend}`,
      ...(backend === 'pi' ? [`  pi:\n    agentDir: ${JSON.stringify(agentDir)}`] : []),
      ...(backend === 'pi' ? ['tui:', '  forceHyperlink: off'] : []),
      '',
    ].join('\n'),
  );
  return {
    root,
    repoRoot,
    env: {
      ...process.env,
      HOME: home,
      ENSEMBLE_USER_ROOT: userRoot,
      ENSEMBLE_AUTH_FIXTURE_RESULT: resultPath,
      FORCE_HYPERLINK: '0',
      NO_OPEN_BROWSER: '1',
      CURSOR_BACKEND_URL: 'http://127.0.0.1:1',
      CURSOR_WEBSITE_URL: 'http://127.0.0.1:1',
    },
  };
}

function runPiLoginInTty(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; sentCode: () => boolean } {
  const child = spawn(
    process.env.PYTHON3 ?? process.env.PYTHON ?? 'python3',
    [
      '-c',
      PYTHON_PTY_RUNNER,
      process.execPath,
      '--import',
      PI_RUNTIME_FIXTURE,
      CLI_ENTRY,
      'auth',
      'login',
      '--repo-root',
      repoRoot,
      '--provider',
      'openai',
    ],
    { detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let codeSent = false;
  const collected = { output: '' };
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    collected.output += chunk;
    if (!codeSent && collected.output.includes(MANUAL_CODE_PROMPT)) {
      codeSent = true;
      child.stdin?.write(`${MANUAL_CODE}\r`);
    }
  });
  return {
    child,
    sentCode: () => codeSent,
  };
}

describe('conductor auth login CLI e2e', () => {
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'shows the Pi OAuth URL, accepts a hidden manual code, and completes login',
    async () => {
      const fixture = await createLoginFixture('pi');
      fixtureRoot = fixture.root;
      const { child, sentCode } = runPiLoginInTty(
        fixture.repoRoot,
        fixture.env,
      );
      const result = await collectProcess(child);
      const capture = JSON.parse(
        await readFile(fixture.env.ENSEMBLE_AUTH_FIXTURE_RESULT!, 'utf8'),
      ) as {
        provider: string;
        method: string;
        authorizationCode: string;
      };

      expect(sentCode()).toBe(true);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Pi: logged in provider openai (oauth)');
      const urlPosition = result.stdout.indexOf(
        'https://auth.example.test/authorize?state=cli-e2e',
      );
      const promptPosition = result.stdout.indexOf(
        'Paste the authorization code',
      );
      expect(urlPosition).toBeGreaterThanOrEqual(0);
      expect(promptPosition).toBeGreaterThan(urlPosition);
      expect(result.stdout).not.toContain(MANUAL_CODE);
      expect(capture).toEqual({
        provider: 'openai',
        method: 'oauth',
        authorizationCode: MANUAL_CODE,
      });
    },
  );

  it('keeps Cursor login available through the real CLI without a TTY or credentials', async () => {
    const fixture = await createLoginFixture('cursor');
    fixtureRoot = fixture.root;
    const child = spawn(
      process.execPath,
      [
        '--import',
        CURSOR_LOGIN_FIXTURE,
        CLI_ENTRY,
        'auth',
        'login',
        '--repo-root',
        fixture.repoRoot,
      ],
      { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const result = await collectProcess(child);
    const capture = JSON.parse(
      await readFile(fixture.env.ENSEMBLE_AUTH_FIXTURE_RESULT!, 'utf8'),
    ) as { called: boolean; argumentCount: number };

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Logged in as fixture@example.test');
    expect(result.stdout).toContain('API key expires: 2030-03-17T17:46:40.000Z');
    expect(capture).toEqual({ called: true, argumentCount: 0 });
  });
});
