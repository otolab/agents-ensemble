import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A real PTY is needed: ink-testing-library does not exercise the same
// measurement and viewport feedback as an actual terminal.
const runner = String.raw`
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave,
    stderr=slave, start_new_session=True, env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
def read_until(deadline):
    result = bytearray()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try: result.extend(os.read(master, 65536))
            except OSError: break
    return result
try:
    initial = bytearray()
    deadline = time.monotonic() + 10
    while b'Operator input' not in initial and time.monotonic() < deadline and child.poll() is None:
        initial.extend(read_until(time.monotonic() + 0.1))
    if b'Operator input' not in initial: raise RuntimeError('TUI did not start: ' + repr(initial[-1000:]))
    value = sys.argv[3].encode()
    os.write(master, b'\x1b[200~' + value + b'\x1b[201~')
    output = read_until(time.monotonic() + 3)
    if child.poll() is not None: raise RuntimeError('TUI exited: ' + repr(output[-1000:]))
    if b'Maximum update depth' in output: raise RuntimeError('Maximum update depth exceeded')
    if len(output) > 150000: raise RuntimeError('TUI did not settle: %d bytes' % len(output))
    if value[-12:] not in output: raise RuntimeError('input missing from terminal output')
    # Verify the input still accepts editing after settling.
    os.write(master, b'Z')
    edited = read_until(time.monotonic() + 0.7)
    if b'Z' not in edited or b'Maximum update depth' in edited:
        raise RuntimeError('input did not remain usable')
finally:
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    os.close(master)
`;

describe('operator input in a real TUI', () => {
  it.skipIf(process.platform === 'win32').each([
    ['reported input', 'https://github.com/otolab/agents-ensemble/pull/823#issuecomment-7058075556ここにある'],
    ['full first line', 'a'.repeat(74)],
    ['viewport height limit', 'a'.repeat(74) + '日'.repeat(38 * 7)],
  ])('settles with %s', (_label, value) => {
    const fixture = fileURLToPath(new URL('../process-fixtures/operator-input-pty.mjs', import.meta.url));
    expect(() => execFileSync('python3', ['-c', runner, process.execPath, fixture, value], {
      timeout: 20_000,
      encoding: 'utf8',
    })).not.toThrow();
  });
});
