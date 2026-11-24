import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Inspect every complete redraw immediately after each operation, including
// redraws that the settling window in the convergence test would discard.
const boundaryRunner = String.raw`
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 25, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], sys.argv[3]], stdin=slave, stdout=slave,
    stderr=slave, start_new_session=True, env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
def read_for(seconds):
    result = bytearray()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.02)
        if ready:
            try: result.extend(os.read(master, 65536))
            except OSError: break
    return result
def frames(output):
    text = output.decode('utf-8', errors='replace')
    text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    return re.findall(r'┌─ Operator input[^\n]*\n(.*?)└[^\n]*', text.replace('\r', ''), re.S)
try:
    initial = bytearray()
    deadline = time.monotonic() + 10
    while b'Operator input' not in initial and time.monotonic() < deadline and child.poll() is None:
        initial.extend(read_for(0.1))
    if b'Operator input' not in initial: raise RuntimeError('TUI did not start')
    url = b'https://github.com/otolab/agents-ensemble/pull/823#issuecomment-7058075556'
    os.write(master, b'\x1b[200~' + url[:-1] + b'\x1b[201~')
    read_for(0.6)
    def check(label, key, expected_lines):
        os.write(master, key)
        output = read_for(0.35)
        if child.poll() is not None: raise RuntimeError(label + ': TUI exited')
        if b'Maximum update depth' in output: raise RuntimeError(label + ': update loop')
        if '…'.encode() in output or b'...' in output:
            raise RuntimeError(label + ': unexpected ellipsis in PTY output')
        observed = frames(output)
        if not observed: raise RuntimeError(label + ': no complete input redraw')
        counts = [len(frame.splitlines()) for frame in observed]
        if any(count != expected_lines for count in counts):
            raise RuntimeError(label + ': inconsistent input pane heights: ' + repr(counts))
    check('type 74th', url[-1:], 2)
    check('left', b'\x1b[D', 1)
    check('right', b'\x1b[C', 2)
    check('delete 74th', b'\x7f', 1)
    check('restore 74th', url[-1:], 2)
    check('append fullwidth', 'こ'.encode(), 2)
    check('delete fullwidth', b'\x7f', 2)
finally:
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    os.close(master)
`;

describe('operator input boundary in a real TUI', () => {
  it.skipIf(process.platform === 'win32').each(['pane', 'stream'])(
    'keeps each boundary redraw consistent in %s mode',
    (mode) => {
      const fixture = fileURLToPath(new URL('../process-fixtures/operator-input-pty.mjs', import.meta.url));
      expect(() => execFileSync('python3', ['-c', boundaryRunner, process.execPath, fixture, mode], {
        timeout: 20_000,
        encoding: 'utf8',
      })).not.toThrow();
    },
  );

});
