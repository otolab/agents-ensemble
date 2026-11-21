import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A real PTY is needed: ink-testing-library does not exercise the same
// measurement and viewport feedback as an actual terminal.
// The fixture imports dist, so run `pnpm build` before invoking this test.
const runner = String.raw`
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time
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
    def snapshots(output):
        text = output.decode('utf-8', errors='replace')
        text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]', '', text)
        text = text.replace('\r', '')
        frames = re.findall(r'┌─ Operator input[^\n]*\n(.*?)└[^\n]*', text, re.S)
        return [tuple(line.rstrip(' │') for line in frame.splitlines()) for frame in frames]
    def check(stage, marker):
        settling = read_until(time.monotonic() + 0.75)
        output = read_until(time.monotonic() + 2.5)
        if child.poll() is not None: raise RuntimeError(stage + ': TUI exited')
        if b'Maximum update depth' in settling + output: raise RuntimeError(stage + ': Maximum update depth exceeded')
        frames = snapshots(output)
        if len(frames) < 3: raise RuntimeError(stage + ': too few frames to establish stability: ' + repr(frames))
        # Ignore blank cursor-only rows and cursor styling, but require all
        # observed content frames throughout the observation window to agree.
        normalized = [tuple(line for line in frame if line.strip()) for frame in frames]
        if len(set(normalized)) != 1: raise RuntimeError(stage + ': viewport did not settle: ' + repr(normalized))
        if marker not in '\n'.join(normalized[-1]):
            raise RuntimeError(stage + ': expected marker absent from final viewport: ' + repr(normalized[-1]))
    os.write(master, b'\x1b[200~' + value + b'\x1b[201~')
    check('paste', sys.argv[4])
    if sys.argv[5] == 'move':
        os.write(master, b'\x01')  # Ctrl-A: logical line start, first row visible
        check('start', 'a' * 30)
        os.write(master, b'\x05')  # Ctrl-E: logical line end, first row hidden
        check('end', '終')
    if sys.argv[5] == 'tab':
        os.write(master, b'\x01')
        check('tab start', 'a' * 30)
        os.write(master, b'\x05')
        check('tab end', 'a' * 30)
    os.write(master, b'Z')
    check('edit', '終Z' if sys.argv[5] == 'move' else 'Z')

finally:
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    os.close(master)
`;

describe('operator input in a real TUI', () => {
  it.skipIf(process.platform === 'win32').each([
    ['reported input', 'https://github.com/otolab/agents-ensemble/pull/823#issuecomment-7058075556ここにある', 'ここにある', 'stay'],
    ['full first line', 'a'.repeat(74), 'a'.repeat(30), 'stay'],
    ['pasted tab at line end', 'a'.repeat(70) + '\t', 'a'.repeat(30), 'tab'],
    ['viewport height limit', 'a'.repeat(74) + '日'.repeat(38 * 7 - 1) + '終', '終', 'move'],
  ])('settles with %s', (_label, value, marker, mode) => {
    const fixture = fileURLToPath(new URL('../process-fixtures/operator-input-pty.mjs', import.meta.url));
    expect(() => execFileSync('python3', ['-c', runner, process.execPath, fixture, value, marker, mode], {
      timeout: 30_000,
      encoding: 'utf8',
    })).not.toThrow();
  });
});
