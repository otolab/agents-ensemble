import { describe, expect, it } from 'vitest';
import { resolveTuiLayoutMode, TUI_LAYOUT_ENV } from './tui-layout-mode.js';

describe('resolveTuiLayoutMode', () => {
  it('selects stream only for the explicit stream value on TTY', () => {
    expect(
      resolveTuiLayoutMode({ env: { [TUI_LAYOUT_ENV]: 'stream' }, isTty: true }),
    ).toBe('stream');
  });

  it('keeps pane as the default and for unknown values', () => {
    expect(resolveTuiLayoutMode({ env: {}, isTty: true })).toBe('pane');
    expect(
      resolveTuiLayoutMode({ env: { [TUI_LAYOUT_ENV]: 'unknown' }, isTty: true }),
    ).toBe('pane');
  });

  it('falls back to pane for non-TTY sessions even when stream is requested', () => {
    expect(
      resolveTuiLayoutMode({ env: { [TUI_LAYOUT_ENV]: 'stream' }, isTty: false }),
    ).toBe('pane');
  });
});
