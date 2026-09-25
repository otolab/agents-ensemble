import { describe, expect, it, vi } from 'vitest';
import { ConductorToolRegistry } from './conductor-tool.js';
import { toSdkCustomTools } from './conductor-tool-sdk-adapter.js';

describe('toSdkCustomTools', () => {
  it('converts a registry without leaking the backend-neutral name field', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const inputSchema = { type: 'object', properties: {} };
    const registry = new ConductorToolRegistry().register({
      name: 'demo',
      description: 'Demo tool',
      inputSchema,
      execute,
    });

    const tools = toSdkCustomTools(registry);

    expect(tools).toEqual({
      demo: {
        description: 'Demo tool',
        inputSchema,
        execute,
      },
    });
    await expect(tools.demo.execute({})).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(execute).toHaveBeenCalledWith({});
  });
});
