import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveUserEnsembleRoot } from './resolve-user-ensemble-root.js';

describe('resolveUserEnsembleRoot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses ENSEMBLE_USER_ROOT before the default home directory', () => {
    vi.stubEnv('ENSEMBLE_USER_ROOT', '/tmp/ensemble-user-root');

    expect(resolveUserEnsembleRoot()).toBe('/tmp/ensemble-user-root');
  });

  it('keeps explicit roots and home overrides ahead of the environment', () => {
    vi.stubEnv('ENSEMBLE_USER_ROOT', '/tmp/ensemble-user-root');

    expect(
      resolveUserEnsembleRoot({ userEnsembleRoot: '/explicit/root' }),
    ).toBe('/explicit/root');
    expect(resolveUserEnsembleRoot({ home: '/explicit/home' })).toBe(
      '/explicit/home/.ensemble',
    );
  });
});
