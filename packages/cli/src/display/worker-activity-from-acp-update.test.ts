import { describe, expect, it } from 'vitest';
import { workerActivityFromAcpUpdate } from './worker-activity-from-acp-update.js';

describe('workerActivityFromAcpUpdate', () => {
  it('maps thought chunks to thinking', () => {
    expect(workerActivityFromAcpUpdate('agent_thought_chunk')).toBe('thinking');
  });

  it('maps tool_call with tool name to calling', () => {
    expect(workerActivityFromAcpUpdate('tool_call', 'Shell')).toBe('calling: Shell');
  });

  it('maps browsing tools', () => {
    expect(workerActivityFromAcpUpdate('tool_call', 'WebFetch')).toBe(
      'browsing: WebFetch',
    );
  });

  it('returns undefined for unclassified updates', () => {
    expect(workerActivityFromAcpUpdate('session_info_update')).toBeUndefined();
  });
});
