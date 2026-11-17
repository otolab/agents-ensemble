import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import xterm from '@xterm/headless';
import { createOperatorAgentTuiHost } from './operator-agent-tui.js';

const { Terminal } = xterm;

describe('operator agent terminal', () => {
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
