import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockList } = vi.hoisted(() => ({
  mockList: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  AuthenticationError: class AuthenticationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthenticationError';
    }
  },
  Cursor: {
    models: {
      list: mockList,
    },
  },
}));

import { listConductorModels } from './list-conductor-models.js';

describe('listConductorModels', () => {
  afterEach(() => {
    mockList.mockReset();
    delete process.env.CURSOR_API_KEY;
  });

  it('returns models from Cursor.models.list', async () => {
    mockList.mockResolvedValue([
      { id: 'default', displayName: 'Auto' },
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
    ]);

    const models = await listConductorModels();

    expect(models).toHaveLength(2);
    expect(mockList).toHaveBeenCalledWith({});
  });

  it('passes explicit apiKey to Cursor.models.list', async () => {
    mockList.mockResolvedValue([]);

    await listConductorModels({ apiKey: 'cursor_test' });

    expect(mockList).toHaveBeenCalledWith({ apiKey: 'cursor_test' });
  });

  it('wraps AuthenticationError with conductor auth hint', async () => {
    const { AuthenticationError } = await import('@cursor/sdk');
    mockList.mockRejectedValue(new AuthenticationError('not logged in'));

    await expect(listConductorModels()).rejects.toThrow(/ensemble auth login/);
  });
});
