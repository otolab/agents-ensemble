import { describe, expect, it } from 'vitest';
import { conductorActivityFromSendProgress } from './conductor-activity-from-send-progress.js';

describe('conductorActivityFromSendProgress', () => {
  it('maps read to reading', () => {
    expect(conductorActivityFromSendProgress('read')).toBe('reading');
  });

  it('maps grep to grep', () => {
    expect(conductorActivityFromSendProgress('grep')).toBe('grep');
  });

  it('maps shell to calling: Shell', () => {
    expect(conductorActivityFromSendProgress('shell')).toBe('calling: Shell');
  });

  it('maps MCP tools to calling', () => {
    expect(conductorActivityFromSendProgress('mcp:prompt_worker/dispatch')).toBe(
      'calling: mcp:prompt_worker/dispatch',
    );
  });

  it('falls back to calling with capitalized tool name', () => {
    expect(conductorActivityFromSendProgress('list_workers')).toBe(
      'calling: List_workers',
    );
  });
});
