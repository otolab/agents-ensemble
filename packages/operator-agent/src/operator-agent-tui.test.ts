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
    } finally { await host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
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
      await host.dispose();
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
  } finally { await host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
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
    await host.dispose();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(output.lastIndexOf('\u001b[?25h')).toBeGreaterThan(output.lastIndexOf('\u001b[?25l'));
    expect(stdout.listenerCount('resize')).toBe(0);
  } finally { terminal.dispose(); stdin.destroy(); stdout.destroy(); }
});

describe('shutdown during resize recovery', () => {
  it.each([
    { columns: 30, rows: 10, input: '\u0003', multiline: true, delay: 30 },
    { columns: 30, rows: 10, input: '\u0003', multiline: true, delay: 155 },
    { columns: 50, rows: 16, input: '\r', multiline: false, delay: 30 },
  ])('retains a clean final terminal for $columns x $rows', async ({ columns, rows, input, multiline, delay }) => {
    const terminal = new Terminal({ cols: 40, rows: 12, scrollback: 1000, allowProposedApi: true, convertEol: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
    let output = '';
    stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); terminal.write(chunk); });
    let stopped: Promise<void> | undefined;
    const stop = () => { stopped = Promise.resolve(host.dispose()); };
    const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: stop, onInterrupt: stop });
    const history = () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    try {
      await vi.waitFor(() => expect(history()).toContain('user>'));
      host.appendChannel('harness', 'LOG-A');
      await vi.waitFor(() => expect(history()).toContain('LOG-A'));
      stdin.write(multiline ? 'draft-XYZ' : '/exit');
      await vi.waitFor(() => expect(history()).toContain(multiline ? 'draft-XYZ' : '/exit'));
      if (multiline) {
        stdin.write('\u001b[27;2;13~');
        await new Promise((resolve) => setTimeout(resolve, 50));
        stdin.write('second-line');
        await vi.waitFor(() => expect(history()).toContain('second-line'));
      }
      terminal.resize(columns, rows); stdout.columns = columns; stdout.rows = rows; stdout.emit('resize');
      host.appendChannel('observation', 'LOG-B');
      await new Promise((resolve) => setTimeout(resolve, delay));
      stdin.write(input);
      await vi.waitFor(() => expect(stopped).toBeDefined());
      await stopped;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await new Promise<void>((resolve) => terminal.write('', resolve));
      const result = history();
      expect(result.split('LOG-A')).toHaveLength(2);
      expect(result.split('LOG-B')).toHaveLength(2);
      expect(result.indexOf('LOG-A')).toBeLessThan(result.indexOf('LOG-B'));
      expect(result.split('user>')).toHaveLength(2);
      if (multiline) {
        expect(result.split('draft-XYZ')).toHaveLength(2);
        expect(result.split('second-line')).toHaveLength(2);
      }
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output.lastIndexOf('\u001b[?25h')).toBeGreaterThan(output.lastIndexOf('\u001b[?25l'));
      expect(stdout.listenerCount('resize')).toBe(0);
    } finally { if (!stopped) await await host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
  });
});

describe('resize while shutdown is waiting', () => {
  it.each([
    { sizes: [[30, 10], [20, 8], [20, 8]] as const, input: '\u0003', multiline: true },
    { sizes: [[30, 10], [20, 8], [25, 9]] as const, input: '\u0003', multiline: true },
    { sizes: [[30, 10], [50, 16], [45, 14]] as const, input: '\r', multiline: false },
  ])('settles successive resizes before final output', async ({ sizes, input, multiline }) => {
    const terminal = new Terminal({ cols: 40, rows: 12, scrollback: 1000, allowProposedApi: true, convertEol: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
    let output = '';
    stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); terminal.write(chunk); });
    let stopped: Promise<void> | undefined;
    const stop = () => { stopped = host.dispose(); };
    const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: stop, onInterrupt: stop });
    const history = () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    const resize = ([columns, rows]: readonly [number, number]) => {
      terminal.resize(columns, rows); stdout.columns = columns; stdout.rows = rows; stdout.emit('resize');
    };
    try {
      await vi.waitFor(() => expect(history()).toContain('user>'));
      host.appendChannel('harness', 'LOG-A');
      await vi.waitFor(() => expect(history()).toContain('LOG-A'));
      stdin.write(multiline ? 'draft-XYZ' : '/exit');
      await vi.waitFor(() => expect(history()).toContain(multiline ? 'draft-XYZ' : '/exit'));
      if (multiline) {
        stdin.write('\u001b[27;2;13~');
        await new Promise((resolve) => setTimeout(resolve, 50));
        stdin.write('second-line');
        await vi.waitFor(() => expect(history()).toContain('second-line'));
      }
      resize(sizes[0]);
      host.appendChannel('observation', 'LOG-B');
      stdin.write(input);
      await vi.waitFor(() => expect(stopped).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 30));
      resize(sizes[1]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      resize(sizes[2]);
      await stopped;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await new Promise<void>((resolve) => terminal.write('', resolve));
      const result = history();
      const [columns] = sizes[2];
      expect(result).toContain(`╭${'─'.repeat(columns - 2)}╮`);
      expect(result).toContain(`╰${'─'.repeat(columns - 2)}╯`);
      expect(result.split('╭')).toHaveLength(2);
      expect(result.split('╰')).toHaveLength(2);
      expect(result.split('user>')).toHaveLength(2);
      expect(result.split('LOG-A')).toHaveLength(2);
      expect(result.split('LOG-B')).toHaveLength(2);
      expect(result.indexOf('LOG-A')).toBeLessThan(result.indexOf('LOG-B'));
      if (multiline) {
        expect(result.split('draft-XYZ')).toHaveLength(2);
        expect(result.split('second-line')).toHaveLength(2);
      }
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output.lastIndexOf('\u001b[?25h')).toBeGreaterThan(output.lastIndexOf('\u001b[?25l'));
      expect(stdout.listenerCount('resize')).toBe(0);
    } finally { if (!stopped) await host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
  });
});

it('finishes shutdown while resize continues and retains the final activity', async () => {
  const terminal = new Terminal({ cols: 40, rows: 12, scrollback: 1000, allowProposedApi: true, convertEol: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); terminal.write(chunk); });
  const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: vi.fn(), onInterrupt: vi.fn() });
  const history = () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  let resizeInterval: ReturnType<typeof setInterval> | undefined;
  let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await vi.waitFor(() => expect(history()).toContain('user>'));
    host.appendChannel('harness', 'LOG-A');
    await vi.waitFor(() => expect(history()).toContain('LOG-A'));
    stdin.write('draft-XYZ');
    await vi.waitFor(() => expect(history()).toContain('draft-XYZ'));
    stdout.columns = 30; stdout.rows = 10; terminal.resize(30, 10); stdout.emit('resize');
    host.appendChannel('observation', 'LOG-B');
    const started = Date.now();
    const stopped = host.dispose();
    let index = 0;
    resizeInterval = setInterval(() => {
      const width = 30 + (++index % 2);
      stdout.columns = width; terminal.resize(width, 10); stdout.emit('resize');
    }, 50);
    await Promise.race([
      stopped,
      new Promise<never>((_, reject) => { shutdownTimeout = setTimeout(() => reject(new Error('shutdown did not finish')), 1800); }),
    ]);
    clearTimeout(shutdownTimeout); shutdownTimeout = undefined;
    expect(Date.now() - started).toBeLessThan(1800);
    clearInterval(resizeInterval); resizeInterval = undefined;
    await new Promise<void>((resolve) => terminal.write('', resolve));
    const result = history();
    expect(result.split('LOG-A')).toHaveLength(2);
    expect(result.split('LOG-B')).toHaveLength(2);
    expect(result.indexOf('LOG-A')).toBeLessThan(result.indexOf('LOG-B'));
    expect(result.split('draft-XYZ')).toHaveLength(2);
    expect(result.split('user>')).toHaveLength(2);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(output.lastIndexOf('\u001b[?25h')).toBeGreaterThan(output.lastIndexOf('\u001b[?25l'));
    expect(stdout.listenerCount('resize')).toBe(0);
  } finally {
    if (resizeInterval) clearInterval(resizeInterval);
    if (shutdownTimeout) clearTimeout(shutdownTimeout);
    terminal.dispose(); stdin.destroy(); stdout.destroy();
  }
});

it('updates the status without accumulating it and keeps input responsive', async () => {
  const terminal = new Terminal({ cols: 50, rows: 12, allowProposedApi: true, convertEol: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 50, rows: 12 });
  stdout.on('data', (chunk: Buffer) => terminal.write(chunk));
  const submit = vi.fn();
  const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: submit, onInterrupt: vi.fn() });
  const lines = () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
  try {
    await vi.waitFor(() => expect(lines()).toContain('待機中'));
    stdin.write('draft');
    for (const status of ['thinking', 'calling tool', 'writing', '待機中']) {
      host.setStatus(status);
      await vi.waitFor(() => expect(lines()).toContain(`operator: ${status}`));
    }
    expect(lines()).not.toContain('operator: thinking');
    expect(lines()).not.toContain('operator: calling tool');
    host.setStatus('thinking');
    await vi.waitFor(() => expect(lines()).toContain('thinking (1s)'), { timeout: 2500 });
    terminal.resize(40, 10); stdout.columns = 40; stdout.rows = 10; stdout.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 300));
    host.setStatus('待機中');
    await vi.waitFor(() => expect(lines()).toContain('待機中 (0s)'));
    expect(lines()).not.toContain('thinking (1s)');
    stdin.write('\r');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('draft'));
  } finally { await host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
});

it('keeps elapsed time visible for a long tool name through resize', async () => {
  const terminal = new Terminal({ cols: 40, rows: 12, allowProposedApi: true, convertEol: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
  stdout.on('data', (chunk: Buffer) => terminal.write(chunk));
  const host = createOperatorAgentTuiHost({ stdin, stdout, colorEnabled: false, onSubmit: vi.fn(), onInterrupt: vi.fn() });
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
  try {
    host.setStatus('calling register_conductor_message_listen');
    await vi.waitFor(() => expect(screen()).toMatch(/operator: calling .+ \(1s\)/), { timeout: 2500 });
    host.setStatus('calling register_conductor_message_listen');
    expect(screen()).toMatch(/operator: calling .+ \(1s\)/);
    terminal.resize(30, 10); stdout.columns = 30; stdout.rows = 10; stdout.emit('resize');
    await vi.waitFor(() => expect(screen()).toMatch(/operator: calling .+ \([12]s\)/), { timeout: 2000 });
  } finally { await host.dispose(); terminal.dispose(); stdin.destroy(); stdout.destroy(); }
});
