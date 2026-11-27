import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The clock must trigger a real Ink commit in the same TUI tree as OperatorTextArea.
// Inspect the visible caret and physical cursor after each complete elapsed-second redraw.
const runner = String.raw`
import codecs, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time, unicodedata

class Terminal:
    def __init__(self, columns, needle):
        self.columns = columns
        self.needle = needle
        self.x = 0
        self.y = 0
        self.visible = False
        self.inverse = False
        self.inverse_cells = []
        self.frame_events = []
        self.csi_events = []
        self.cells = {}

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
                        screen = {
                            row: ''.join(cells.get(column, ' ') for column in range(self.columns)).rstrip()
                            for row, cells in self.cells.items()
                        }
                        if any(self.needle in line for line in screen.values()):
                            self.frame_events.append((
                                index, self.x, self.y, self.visible, tuple(self.inverse_cells), screen,
                                tuple(self.csi_events)))
                        self.inverse_cells = []
                        self.csi_events = []
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
                if width:
                    row = self.cells.setdefault(self.y, {})
                    row[self.x] = char
                    for column in range(self.x + 1, min(self.columns, self.x + width)):
                        row[column] = ' '
                self.x = min(self.columns - 1, self.x + width)
            index += 1

    def csi(self, params, final, offset):
        self.csi_events.append((params, final))
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
        if final == 'K':
            row = self.cells.setdefault(self.y, {})
            start = 0 if params == '2' else self.x
            end = self.x + 1 if params == '1' else self.columns
            for column in range(start, end):
                row.pop(column, None)
            self.inverse_cells = [
                cell for cell in self.inverse_cells
                if cell[1] != self.y or cell[0] < start
            ]
            return
        if final == 'J':
            if params in ('2', '3'):
                self.cells.clear()
                self.inverse_cells = []
            elif params == '0':
                for row_index in list(self.cells):
                    if row_index > self.y:
                        del self.cells[row_index]
                    elif row_index == self.y:
                        self.cells[row_index] = {
                            column: char for column, char in self.cells[row_index].items()
                            if column < self.x
                        }
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
columns, rows = int(sys.argv[4]), int(sys.argv[5])
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[7]], stdin=slave, stdout=slave,
    stderr=slave, start_new_session=True,
    env={**os.environ, 'TERM': sys.argv[6]})
os.close(slave)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
output = ''
input_ready_offset = 0
final_line = sys.argv[8].split('\n')[-1]
input_sentinel = final_line[-min(12, len(final_line)):]
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
    terminal = Terminal(columns, input_sentinel)
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
            completed.append((
                current.group(1), event[1], event[2], event[3], event[4], event[5], event[6]))
    return completed
def has_harness_status(frame):
    return any('harness:' in line for line in frame[5].values())
def observed_harness_states(frames):
    states = []
    for frame in frames:
        state = has_harness_status(frame)
        if not states or states[-1] != state:
            states.append(state)
    return states
def required_harness_states():
    if sys.argv[3] != 'operator-agent':
        return []
    if 'toggle-harness' in sys.argv[7]:
        return [False, True, False]
    if 'no-harness' in sys.argv[7]:
        return [False]
    return [True]
def contains_subsequence(values, required):
    position = 0
    for value in values:
        if position < len(required) and value == required[position]:
            position += 1
    return position == len(required)

try:
    initial_deadline = time.monotonic() + 8
    startup_marker = b'user>' if sys.argv[3] == 'operator-agent' else b'Operator input'
    while startup_marker not in output.encode('utf-8') and time.monotonic() < initial_deadline and child.poll() is None:
        read_for(0.05)
    if startup_marker not in output.encode('utf-8'):
        raise RuntimeError('TUI did not render the operator input pane: ' + repr(output[-1000:]))
    input_text = sys.argv[8]
    input_bytes = input_text.encode('utf-8')
    if '\n' in input_text:
        input_bytes = b'\x1b[200~' + input_bytes + b'\x1b[201~'
    os.write(master, input_bytes)
    read_for(0.3)
    input_ready_offset = len(output)
    deadline = time.monotonic() + 9
    required_states = required_harness_states()
    minimum_redraws = 3 if 'toggle-harness' in sys.argv[7] else 2
    while time.monotonic() < deadline and child.poll() is None:
        read_for(0.1)
        redraws = completed_clock_redraws()
        if (len({match.group(1) for match in marker_matches()}) >= 2 and
                len({frame[0] for frame in redraws}) >= 2 and
                len(redraws) >= minimum_redraws and
                contains_subsequence(observed_harness_states(redraws), required_states)):
            read_for(0.15)
            break
    if child.poll() is not None:
        raise RuntimeError('TUI exited before clock redraws: ' + repr(output[-1200:]))
    matches = marker_matches()
    seconds = {match.group(1) for match in matches}
    redraws = completed_clock_redraws()
    redraw_seconds = {frame[0] for frame in redraws}
    if not contains_subsequence(observed_harness_states(redraws), required_states):
        raise RuntimeError('harness status did not pass through required states: ' +
            repr(observed_harness_states(redraws)) + '; expected ' + repr(required_states) +
            '; clock markers=' + str(len(matches)) + '; captured frames=' +
            str(len(redraws)) + ' cursor frames')
    if len(seconds) < 2 or len(redraw_seconds) < 2:
        raise RuntimeError('elapsed seconds did not advance through cursor redraws: ' +
            repr(sorted(redraw_seconds)) + '; status markers=' + repr(sorted(seconds)))
    if len(redraws) < minimum_redraws:
        raise RuntimeError('clock redraws did not re-report a physical cursor after each elapsed value: ' + repr(redraws))
    # Use a unique ASCII suffix so the caret can be found even when the line wraps.
    def expected_input_cell(frame):
        matches = [
            (row, text.find(input_sentinel))
            for row, text in frame[5].items()
            if input_sentinel in text
        ]
        if not matches:
            raise RuntimeError('PTY input suffix was not present in the rendered frame: ' +
                repr(input_sentinel) + '; ' + repr(frame[5]))
        row, column = matches[-1]
        return column + len(input_sentinel), row
    def measured_ink_rows(frame):
        status_rows = [
            row for row, text in frame[5].items()
            if 'operator: clock-fixture' in text
        ]
        if not status_rows:
            raise RuntimeError('operator-agent status row was not present: ' + repr(frame[5]))
        status_row = status_rows[-1]
        bottom_rows = [
            row for row, text in frame[5].items()
            if row > status_row and '╰' in text
        ]
        if not bottom_rows:
            raise RuntimeError('operator-agent input bottom border was not present: ' + repr(frame[5]))
        drawn_rows = min(bottom_rows) - status_row + 1

        # Ink 7.1.1's buildCursorSuffix emits CSI (visibleLineCount - cursorY) A,
        # followed by cursorTo(x) and show-cursor. Recover that cursor-up value
        # from the actual PTY output, then compare its implied line count with
        # the rows between the operator status and the input box's bottom border.
        events = frame[6]
        show_index = next((
            index for index in range(len(events) - 1, -1, -1)
            if events[index][1] == 'h' and '25' in events[index][0].lstrip('?').split(';')
        ), None)
        if show_index is None:
            raise RuntimeError('Ink did not emit a show-cursor sequence: ' + repr(events))
        column_index = next((
            index for index in range(show_index - 1, -1, -1)
            if events[index][1] in ('G', 'H', 'f')
        ), None)
        up_index = next((
            index for index in range(column_index - 1, -1, -1)
            if events[index][1] == 'A'
        ), None) if column_index is not None else None
        if up_index is None:
            raise RuntimeError('Ink cursor suffix had no cursor-up sequence: ' + repr(events))
        try:
            cursor_up = int(events[up_index][0].split(';')[0] or '1')
        except ValueError as error:
            raise RuntimeError('Could not parse Ink cursor-up sequence: ' + repr(events)) from error
        cursor_y = frame[2] - status_row
        visible_line_count = cursor_y + cursor_up
        return {
            'harnessStatus': has_harness_status(frame),
            'drawnRows': drawn_rows,
            'visibleLineCount': visible_line_count,
            'cursorY': cursor_y,
            'cursorUp': cursor_up,
            'cursorSuffix': [
                'CSI ' + str(cursor_up) + ' A',
                'CSI ' + str(frame[1] + 1) + ' G',
                'CSI ?25 h',
            ],
        }
    wrong = []
    measurements = []
    for frame in redraws:
        expected_x, expected_y = expected_input_cell(frame)
        expected_caret = ((expected_x, expected_y),)
        measurement = measured_ink_rows(frame) if sys.argv[3] == 'operator-agent' else None
        if measurement is not None:
            measurements.append({'second': frame[0], **measurement})
        if frame[1:4] != (expected_x, expected_y, True) or (frame[4] and frame[4] != expected_caret):
            wrong.append({
                'second': frame[0],
                'expected': (expected_x, expected_y),
                'physical': frame[1:3],
                'visibleInverseCells': frame[4],
            })
        if measurement is not None and measurement['visibleLineCount'] != measurement['drawnRows']:
            wrong.append({
                'second': frame[0],
                'renderRows': measurement['drawnRows'],
                'visibleLineCount': measurement['visibleLineCount'],
                'cursorSuffix': measurement['cursorSuffix'],
            })
    if wrong:
        raise RuntimeError('physical cursor or visible caret left the input cell during completed clock frames; ' +
            'cursor and visible inverse cells must match the last input line, observed ' + repr(wrong))
    if not any(frame[4] for frame in redraws):
        raise RuntimeError('no visible caret was captured in completed clock frames: ' + repr(redraws))
    print(json.dumps({'measurements': measurements}))
finally:
    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=5)
    os.close(master)
`;

describe('operator input cursor during status clock PTY redraws', () => {
  it.skipIf(process.platform === 'win32').each([
    ['operator-agent', 80, 25, 'xterm-256color', 'operator-agent', 'operator-agent-pty'],
    ['operator-agent', 60, 12, 'tmux-256color', 'operator-agent', 'operator-agent-pty'],
    ['operator-agent', 80, 25, 'xterm-256color', 'operator-agent-no-harness', 'operator-agent-no-harness-pty'],
    ['operator-agent', 80, 25, 'xterm-256color', 'operator-agent-toggle-harness', 'operator-agent-toggle-harness-pty'],
    ['operator-agent', 80, 25, 'xterm-256color', 'operator-agent-multiline', 'first-agent-line\nfinal-agent-line'],
    ['operator-agent', 80, 25, 'xterm-256color', 'operator-agent-wrap', `wrapped-${'x'.repeat(96)}-WRAP-END`],
    ['pane', 80, 25, 'xterm-256color', 'plain', 'single-pty-input'],
    ['pane', 80, 25, 'tmux-256color', 'plain', 'single-pty-input'],
    ['pane', 60, 12, 'tmux-256color', 'plain', 'single-pty-input'],
    ['pane', 80, 40, 'tmux-256color', 'plain', 'single-pty-input'],
    ['pane', 80, 25, 'tmux-256color', 'question-workers', 'first-pty-line\nfinal-pty-line'],
    ['stream', 80, 25, 'xterm-256color', 'plain', 'single-pty-input'],
    ['stream', 80, 25, 'tmux-256color', 'plain', 'single-pty-input'],
    ['stream', 60, 12, 'tmux-256color', 'plain', 'single-pty-input'],
    ['stream', 80, 40, 'tmux-256color', 'plain', 'single-pty-input'],
    ['stream', 80, 25, 'tmux-256color', 'question-workers', 'first-pty-line\nfinal-pty-line'],
  ])(
    'keeps the physical cursor on the input cell and aligns the visible caret in %s mode at %sx%s (%s; %s)',
    (mode, columns, rows, term, scenario, inputText) => {
      const fixture = fileURLToPath(new URL('../process-fixtures/operator-input-clock-pty.mjs', import.meta.url));
      const result = execFileSync('python3', [
        '-c', runner, process.execPath, fixture, mode,
        String(columns), String(rows), term, scenario, inputText,
      ], {
        timeout: 20_000,
        encoding: 'utf8',
      });
      const { measurements } = JSON.parse(result.trim());
      if (mode === 'operator-agent') {
        expect(measurements.length).toBeGreaterThanOrEqual(2);
        const extraInputRow =
          scenario.includes('multiline') || scenario.includes('wrap') ? 1 : 0;
        if (scenario.includes('no-harness')) {
          expect(measurements.every((measurement) => !measurement.harnessStatus)).toBe(true);
        } else if (scenario.includes('toggle-harness')) {
          expect(measurements.some((measurement) => !measurement.harnessStatus)).toBe(true);
          expect(measurements.some((measurement) => measurement.harnessStatus)).toBe(true);
        } else {
          expect(measurements.every((measurement) => measurement.harnessStatus)).toBe(true);
        }
        for (const measurement of measurements) {
          const harnessRow = Number(measurement.harnessStatus);
          expect(measurement.drawnRows).toBe(4 + harnessRow + extraInputRow);
          expect(measurement.visibleLineCount).toBe(measurement.drawnRows);
          expect(measurement.cursorY).toBe(2 + harnessRow + extraInputRow);
          expect(measurement.cursorUp).toBe(2);
          expect(measurement.cursorSuffix[0]).toBe('CSI 2 A');
          expect(measurement.cursorSuffix[2]).toBe('CSI ?25 h');
        }
      }
    },
  );
});
