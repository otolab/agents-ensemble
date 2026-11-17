import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import xterm from '@xterm/headless';
import { createOperatorAgentTuiHost } from './operator-agent-tui.js';

const { Terminal } = xterm;

describe('operator agent terminal', () => {
  it('keeps the editor anchored and undoable after separate resizes', async () => {
    const terminal = new Terminal({ cols: 40, rows: 12, allowProposedApi: true, convertEol: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
    stdout.on('data', (chunk: Buffer) => terminal.write(chunk));
    const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: vi.fn(), onInterrupt: vi.fn() });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '');
    try {
      await vi.waitFor(() => expect(screen().findIndex((line) => line.includes('user>'))).toBe(9));
      stdin.write('undo-me');
      await vi.waitFor(() => expect(screen().join('\n')).toContain('undo-me'));
      for (const [columns, rows] of [[30, 10], [50, 16]] as const) {
        terminal.resize(columns, rows); stdout.columns = columns; stdout.rows = rows; stdout.emit('resize');
        await new Promise((resolve) => setTimeout(resolve, 300));
        await vi.waitFor(() => expect(screen().findIndex((line) => line.includes('user>'))).toBe(rows - 3));
      }
      stdin.write('\u001a');
      await vi.waitFor(() => expect(screen().join('\n')).not.toContain('undo-me'));
    } finally { host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
  });

  it('preserves visible activity, scrollback and the draft cursor across updates', async () => {
    const terminal = new Terminal({ cols: 40, rows: 12, allowProposedApi: true, convertEol: true });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(),
    });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
    stdout.on('data', (chunk: Buffer) => terminal.write(chunk));
    const onSubmit = vi.fn();
    const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit, onInterrupt: vi.fn() });
    const visible = () => Array.from({ length: terminal.rows }, (_, i) =>
      terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '',
    );
    const history = () => Array.from({ length: terminal.buffer.active.length }, (_, i) =>
      terminal.buffer.active.getLine(i)?.translateToString(true) ?? '',
    ).join('\n');
    try {
      await vi.waitFor(() => expect(visible().join('\n')).toContain('user>'));
      expect(visible().findIndex((line) => line.includes('user>'))).toBe(9);
      host.appendChannel('harness', 'first activity');
      await vi.waitFor(() => expect(visible().join('\n')).toContain('first activity'));
      stdin.write('abc日本語');
      await vi.waitFor(() => expect(visible().join('\n')).toContain('abc日本語'));
      stdin.write('\u001b[D');
      await new Promise((resolve) => setTimeout(resolve, 50));
      host.appendOperatorResponse('second response');
      await vi.waitFor(() => expect(visible().join('\n')).toContain('second response'));
      stdin.write('X');
      await vi.waitFor(() => expect(visible().join('\n')).toContain('abc日本X語'));
      const row = visible()[terminal.buffer.active.cursorY] ?? '';
      expect(row).toContain('abc日本X語');
      expect(terminal.buffer.active.cursorX).toBe(2 + 6 + 3 + 4 + 1);
      terminal.resize(30, 10);
      stdout.columns = 30;
      stdout.rows = 10;
      stdout.emit('resize');
      terminal.resize(50, 16);
      stdout.columns = 50;
      stdout.rows = 16;
      stdout.emit('resize');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(visible().findIndex((line) => line.includes('user>'))).toBe(13);
      host.appendChannel('harness', 'after resize');
      await vi.waitFor(() => {
        expect(visible().join('\n')).toContain('after resize');
        expect(visible().join('\n')).toContain('abc日本X語');
      });
      stdin.write('\u001b[27;2;13~');
      await new Promise((resolve) => setTimeout(resolve, 50));
      stdin.write('next line 123456789012345678901234567890');
      await vi.waitFor(() => expect(visible().join('\n')).toContain('next line'));
      expect(visible()[terminal.buffer.active.cursorY]).toContain('890語');
      host.appendChannel('observation', 'multiline update');
      await vi.waitFor(() => expect(visible().join('\n')).toContain('multiline update'));
      stdin.write('\r');
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('abc日本X\nnext line 123456789012345678901234567890語'));
      for (let i = 0; i < 8; i++) host.appendChannel('observation', `entry-${i}`);
      await vi.waitFor(() => expect(visible().join('\n')).toContain('entry-7'));
      expect(history()).toContain('first activity');
      expect(history().match(/entry-7/g)).toHaveLength(1);
    } finally {
      host.dispose();
      terminal.dispose();
      stdin.destroy();
      stdout.destroy();
    }
  });
});

it('replays activity once in order and anchors a wrapped draft through each resize', async () => {
  const terminal = new Terminal({ cols: 40, rows: 12, scrollback: 1000, allowProposedApi: true, convertEol: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
  stdout.on('data', (chunk: Buffer) => terminal.write(chunk));
  const submit = vi.fn();
  const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: submit, onInterrupt: vi.fn() });
  const lines = () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
  const visible = () => lines().slice(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + terminal.rows);
  const check = () => {
    const screen = visible();
    expect(screen[terminal.rows - 2], screen.join('\n')).toContain('╰');
    const line = screen[terminal.buffer.active.cursorY] ?? '';
    const end = line.indexOf('END');
    expect(end).toBeGreaterThanOrEqual(0);
    expect(terminal.buffer.active.cursorX).toBe(end + 3);
    const history = lines().join('\n');
    const positions = ['USER-ONE', 'OPERATOR-TWO', 'HARNESS-THREE', 'OBSERVE-FOUR'].map((marker) => {
      expect(history.split(marker)).toHaveLength(2);
      return history.indexOf(marker);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  };
  try {
    await vi.waitFor(() => expect(visible().join('\n')).toContain('user>'));
    host.appendUserMessage('USER-ONE');
    host.appendOperatorResponse('OPERATOR-TWO');
    host.appendChannel('harness', 'HARNESS-THREE');
    host.appendChannel('observation', 'OBSERVE-FOUR');
    await vi.waitFor(() => expect(visible().join('\n')).toContain('OBSERVE-FOUR'));
    stdin.write('ab日本');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('\u001b[27;2;13~');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write('123456789012345678901234567890END');
    await vi.waitFor(() => expect(visible().join('\n')).toContain('END'));
    check();
    for (const [columns, rows] of [[30, 10], [50, 16]] as const) {
      terminal.resize(columns, rows); stdout.columns = columns; stdout.rows = rows; stdout.emit('resize');
      if (columns === 30) host.appendChannel('harness', 'DURING-RESIZE');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await vi.waitFor(check);
    }
    expect(lines().join('\n').split('DURING-RESIZE')).toHaveLength(2);
    host.appendChannel('harness', 'ASYNC-FIVE');
    await vi.waitFor(() => expect(visible().join('\n')).toContain('ASYNC-FIVE'));
    check();
    stdin.write('\r');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('ab日本\n123456789012345678901234567890END'));
  } finally { host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
});

it('clears prior scrollback on resize and restores terminal state on exit', async () => {
  const terminal = new Terminal({ cols: 40, rows: 12, allowProposedApi: true, convertEol: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); terminal.write(chunk); });
  await new Promise<void>((resolve) => terminal.write('old-shell-history\r\n'.repeat(16), resolve));
  const submit = vi.fn();
  const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: submit, onInterrupt: vi.fn() });
  try {
    await vi.waitFor(() => expect(output).toContain('user>'));
    terminal.resize(30, 10); stdout.columns = 30; stdout.rows = 10; stdout.emit('resize');
    await vi.waitFor(() => expect(output).toContain('\u001b[3J'));
    await new Promise<void>((resolve) => terminal.write('', resolve));
    const history = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\n');
    expect(history).not.toContain('old-shell-history');
    stdin.write('/exit');
    await vi.waitFor(() => expect(output).toContain('/exit'));
    stdin.write('\r');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('/exit'));
    host.dispose();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(output.lastIndexOf('\u001b[?25h')).toBeGreaterThan(output.lastIndexOf('\u001b[?25l'));
    expect(stdout.listenerCount('resize')).toBe(0);
  } finally { terminal.dispose(); stdin.destroy(); stdout.destroy(); }
});
