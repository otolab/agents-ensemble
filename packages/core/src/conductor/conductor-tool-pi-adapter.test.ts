import { describe, expect, it, vi } from 'vitest';
import { ConductorToolRegistry } from './conductor-tool.js';
import { toPiCodingAgentTools } from './conductor-tool-pi-adapter.js';

describe('toPiCodingAgentTools', () => {
  it('converts a registry to Pi tools and forwards the backend-neutral result', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { accepted: true },
    }));
    const inputSchema = { type: 'object', properties: {} };
    const registry = new ConductorToolRegistry().register({
      name: 'prompt_worker',
      description: 'Dispatch work to a worker',
      inputSchema,
      execute,
    });

    const tools = toPiCodingAgentTools(registry);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'prompt_worker',
      label: 'prompt_worker',
      description: 'Dispatch work to a worker',
      parameters: inputSchema,
    });

    await expect(
      tools[0]!.execute('call-1', {}),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      details: { accepted: true },
    });
    expect(execute).toHaveBeenCalledWith({});
  });

  it('uses empty details when a harness tool has no structured result', async () => {
    const registry = {
      ping: {
        name: 'ping',
        description: 'Ping',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
      },
    };

    const [tool] = toPiCodingAgentTools(registry);

    await expect(tool!.execute('call-1', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'pong' }],
      details: {},
    });
  });
});
