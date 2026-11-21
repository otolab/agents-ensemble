import { describe, expect, it, vi } from 'vitest';
import * as tools from './operator-watch-tools.js';
import * as poolExports from './operator-watch-pool.js';
import type { OperatorWatchPool } from './types.js';

describe('watch tool factories', () => {
  it('preserves all six pool re-exports and delegates their inputs and results', async () => {
    const methods = {
      register: vi.fn().mockResolvedValue({ conductorAgentId: 'one' }),
      unregister: vi.fn().mockResolvedValue(true),
      registerRepository: vi.fn().mockResolvedValue({ managedSessionIds: ['a'], manualSessionIds: ['b'] }),
      unregisterRepository: vi.fn().mockResolvedValue(false),
      registerConductorMessageListen: vi.fn().mockResolvedValue({ conductorAgentId: 'one' }),
      unregisterConductorMessageListen: vi.fn().mockResolvedValue(true),
    };
    const pool = methods as unknown as OperatorWatchPool;
    const cases = [
      ['createRegisterSessionWatchTool', 'register_session_watch', { conductorAgentId: ' one ', pollIntervalMs: 1000, debounceMs: 2 }, 'register', ['one', { pollIntervalMs: 1000, debounceMs: 2 }]],
      ['createUnregisterSessionWatchTool', 'unregister_session_watch', { conductorAgentId: ' one ' }, 'unregister', ['one']],
      ['createRegisterRepositoryWatchTool', 'register_repository_watch', { githubRepo: ' org/repo ', scanIntervalMs: 5000 }, 'registerRepository', ['org/repo', { scanIntervalMs: 5000, pollIntervalMs: undefined, debounceMs: undefined }]],
      ['createUnregisterRepositoryWatchTool', 'unregister_repository_watch', { githubRepo: ' org/repo ' }, 'unregisterRepository', ['org/repo']],
      ['createRegisterConductorMessageListenTool', 'register_conductor_message_listen', { conductorAgentId: ' one ', messageDebounceMs: 2 }, 'registerConductorMessageListen', ['one', { messageDebounceMs: 2 }]],
      ['createUnregisterConductorMessageListenTool', 'unregister_conductor_message_listen', { conductorAgentId: ' one ' }, 'unregisterConductorMessageListen', ['one']],
    ] as const;
    for (const [factory, name, args, method, expectedArgs] of cases) {
      expect(poolExports[factory]).toBe(tools[factory]);
      const tool = tools[factory](pool);
      expect(tool.name).toBe(name);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const result = await tool.execute(args);
      expect(methods[method]).toHaveBeenCalledWith(...expectedArgs);
      expect(result.content[0]!.type).toBe('text');
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
      if (method === 'registerRepository') expect(result.structuredContent).toMatchObject({ baselineRunCount: 2, autoWatchLimit: 20 });
    }
  });

  it('rejects invalid tool arguments before calling the pool', async () => {
    const register = vi.fn();
    const tool = tools.createRegisterSessionWatchTool({ register } as unknown as OperatorWatchPool);
    await expect(tool.execute({ conductorAgentId: ' ' })).rejects.toThrow('conductorAgentId must not be empty.');
    await expect(tool.execute({ conductorAgentId: 'one', pollIntervalMs: 'bad' })).rejects.toThrow('pollIntervalMs must be an integer.');
    expect(register).not.toHaveBeenCalled();
  });
});
