import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The clock must trigger a real Ink commit in the same TUI tree as OperatorTextArea.
// Inspect the visible caret and physical cursor after each complete elapsed-second redraw.
const runner = String.raw`
import codecs, fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time, unicodedata

class Terminal:
    def __init__(self, columns):
        self.columns = columns
        self.x = 0
        self.y = 0
        self.visible = False
        self.inverse = False
        self.inverse_cells = []
        self.frame_events = []

    def feed(self, text):
        index = 0
        while index < len(text):
            char = text[index]
            if char == '\x1b':
                if index + 1 >= len(text): break
                next_char = text[index + 1]
                if next_char == '[':
                    end = index + 2
                    while end < len(text) and not ('@' <= text[end] <= '~'):
                        end += 1
                    if end >= len(text): break
                    params = text[index + 2:end]
                    final = text[end]
                    self.csi(params, final, index)
                    index = end + 1
                    continue
                if next_char == ']':
                    end_bel = text.find('\x07', index + 2)
                    end_st = text.find('\x1b\\', index + 2)
                    candidates = [end for end in (end_bel, end_st) if end >= 0]
                    if not candidates: break
                    end = min(candidates)
                    osc = text[index + 2:end]
                    if osc == '777;ensemble-frame':
                        self.frame_events.append((
                            index, self.x, self.y, self.visible, tuple(self.inverse_cells)))
                        self.inverse_cells = []
                    index = end + (2 if end == end_st else 1)
                    continue
                if next_char == 'M':
                    self.y = max(0, self.y - 1)
                    index += 2
                    continue
                index += 2
                continue
            if char == '\r':
                self.x = 0
            elif char == '\n':
                self.y += 1
            elif char == '\b':
                self.x = max(0, self.x - 1)
            elif char == '\t':
                self.x = min(self.columns - 1, ((self.x // 8) + 1) * 8)
            elif ord(char) >= 32 and char != '\x7f':
                if unicodedata.combining(char):
                    width = 0
                elif unicodedata.east_asian_width(char) in ('W', 'F'):
                    width = 2
                else:
                    width = 1
                if width and self.x + width > self.columns:
                    self.x = 0
                    self.y += 1
                if width and self.inverse:
                    self.inverse_cells.append((self.x, self.y))
                self.x = min(self.columns - 1, self.x + width)
            index += 1

    def csi(self, params, final, offset):
        if final in ('h', 'l') and params.startswith('?'):
            modes = [part for part in params[1:].split(';') if part]
            if '25' in modes:
                self.visible = final == 'h'
            return
        if final == 'm':
            for mode in params.split(';') if params else ['0']:
                if mode in ('0', '27'):
                    self.inverse = False
                elif mode == '7':
                    self.inverse = True
            return
        numbers = params.lstrip('?').split(';') if params else []
        def number(position, default=1):
            try: return int(numbers[position]) or default
            except (IndexError, ValueError): return default
        if final == 'A': self.y = max(0, self.y - number(0))
        elif final == 'B': self.y += number(0)
        elif final == 'C': self.x = min(self.columns - 1, self.x + number(0))
        elif final == 'D': self.x = max(0, self.x - number(0))
        elif final == 'E': self.y += number(0); self.x = 0
        elif final == 'F': self.y = max(0, self.y - number(0)); self.x = 0
        elif final == 'G': self.x = min(self.columns - 1, number(0) - 1)
        elif final in ('H', 'f'):
            self.y = max(0, number(0) - 1)
            self.x = min(self.columns - 1, number(1) - 1)

master, slave = pty.openpty()
columns, rows = 80, 25
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], sys.argv[3]], stdin=slave, stdout=slave,
    stderr=slave, start_new_session=True, env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
output = ''
input_ready_offset = 0
def read_for(seconds):
    global output
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try: data = os.read(master, 65536)
            except OSError: break
            decoded = decoder.decode(data)
            output += decoded
def terminal_events():
    terminal = Terminal(columns)
    terminal.feed(output)
    return terminal.frame_events
def marker_matches():
    return [
        match for match in re.finditer(r'clock-fixture \((\d+)s\)', output)
        if match.start() >= input_ready_offset
    ]
def completed_clock_redraws():
    matches = marker_matches()
    events = terminal_events()
    completed = []
    for current, following in zip(matches[1:], matches[2:] + [None]):
        end = following.start() if following else len(output)
        marker_end = current.end()
        event = next((item for item in events if marker_end <= item[0] < end), None)
        if event is not None:
            completed.append((current.group(1), event[1], event[2], event[3], event[4]))
    return completed

try:
    initial_deadline = time.monotonic() + 8
    while b'Operator input' not in output.encode('utf-8') and time.monotonic() < initial_deadline and child.poll() is None:
        read_for(0.05)
    if b'Operator input' not in output.encode('utf-8'):
        raise RuntimeError('TUI did not render the operator input pane: ' + repr(output[-1000:]))
    os.write(master, b'abc')
    read_for(0.3)
    input_ready_offset = len(output)
    deadline = time.monotonic() + 9
    while time.monotonic() < deadline and child.poll() is None:
        read_for(0.1)
        if len({match.group(1) for match in marker_matches()}) >= 2 and len(completed_clock_redraws()) >= 2:
            read_for(0.15)
            break
    if child.poll() is not None:
        raise RuntimeError('TUI exited before clock redraws: ' + repr(output[-1200:]))
    matches = marker_matches()
    seconds = {match.group(1) for match in matches}
    redraws = completed_clock_redraws()
    if len(seconds) < 2:
        raise RuntimeError('elapsed seconds did not advance: ' + repr(sorted(seconds)))
    if len(redraws) < 2:
        raise RuntimeError('clock redraws did not re-report a physical cursor after each elapsed value: ' + repr(redraws))
    expected_x, expected_y = int(sys.argv[4]), int(sys.argv[5])
    expected_caret = ((expected_x, expected_y),)
    wrong = [
        frame for frame in redraws
        if frame[1:4] != (expected_x, expected_y, True)
        or (frame[4] and frame[4] != expected_caret)
    ]
    if wrong:
        raise RuntimeError('physical cursor or visible caret left the input cell during completed clock frames; ' +
            'visible inverse cells must contain only ' + repr(expected_caret) + ', observed ' + repr(redraws))
    if not any(frame[4] for frame in redraws):
        raise RuntimeError('no visible caret was captured in completed clock frames: ' + repr(redraws))
finally:
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    os.close(master)
`;

describe('operator input cursor during conductor clock PTY redraws', () => {
  it.skipIf(process.platform === 'win32').each([
    ['pane', 7, 22],
    ['stream', 7, 1],
  ])('keeps the physical cursor on the input cell and aligns the visible caret in %s mode', (mode, x, y) => {
    const fixture = fileURLToPath(new URL('../process-fixtures/operator-input-clock-pty.mjs', import.meta.url));
    expect(() => execFileSync('python3', ['-c', runner, process.execPath, fixture, mode, String(x), String(y)], {
      timeout: 20_000,
      encoding: 'utf8',
    })).not.toThrow();
  });
});
