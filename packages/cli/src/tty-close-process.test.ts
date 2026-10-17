import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

describe('TTY /close process lifecycle', () => {
  it.skipIf(process.platform === 'win32')(
    'accepts /close through a real TTY and exits after production teardown',
    async () => {
      const fixturePath = fileURLToPath(
        new URL('../test/process-fixtures/tty-close-process.mjs', import.meta.url),
      );
      const childResult = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const pythonExecutable =
          process.env.PYTHON3 ?? process.env.PYTHON ?? 'python3';
        const child = spawn(
          pythonExecutable,
          ['-c', PYTHON_PTY_RUNNER, process.execPath, fixturePath],
          {
            detached: true,
            env: {
              ...process.env,
              TERM: process.env.TERM ?? 'xterm-256color',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        let settled = false;
        let closeCommandSent = false;
        let closeEnterSent = false;
        const killProcessGroup = () => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          killProcessGroup();
          const outputTail = stripTerminalControls(stdout).slice(-8_000);
          reject(
            new Error(
              `TTY /close child did not exit naturally within 15 seconds; ` +
                `inputReady=${stdout.includes('TTY_CLOSE_INPUT_READY')}; ` +
                `commandSent=${closeCommandSent}; ` +
                `enterSent=${closeEnterSent}; ` +
                `closeSubmitted=${stdout.includes('TTY_CLOSE_SUBMITTED accepted=false')}\n` +
                `stdout tail:\n${outputTail}\nstderr:\n${stderr}`,
            ),
          );
        }, 15_000);

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
          if (!closeCommandSent && stdout.includes('TTY_CLOSE_INPUT_READY')) {
            closeCommandSent = true;
            child.stdin.write('/close');
            setTimeout(() => {
              if (settled) return;
              closeEnterSent = true;
              child.stdin.write('\r');
            }, 100);
          }
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            killProcessGroup();
            reject(error);
          }
        });
        child.once('close', (code, signal) => {
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          resolve({ code, signal, stdout, stderr });
        });
      });

      expect(
        childResult.code,
        `${childResult.stderr}\n${stripTerminalControls(childResult.stdout).slice(-4_000)}`,
      ).toBe(0);
      expect(childResult.signal).toBeNull();
      expect(childResult.stdout).toContain('TTY_CLOSE_INPUT_READY');
      expect(childResult.stdout).toContain('TTY_CLOSE_SUBMITTED accepted=false');
      expect(childResult.stdout).toContain('close-process-session-completed');
    },
    20_000,
  );
});
