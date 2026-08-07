import { afterEach, describe, expect, it } from 'vitest';
import { resolveConductorApiKey } from './conductor-auth.js';

describe('resolveConductorApiKey', () => {
  const original = process.env.CURSOR_API_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = original;
    }
  });

  it('prefers an explicit apiKey', () => {
    process.env.CURSOR_API_KEY = 'from-env';
    expect(resolveConductorApiKey('explicit')).toBe('explicit');
  });

  it('falls back to CURSOR_API_KEY when explicit is omitted', () => {
    process.env.CURSOR_API_KEY = 'from-env';
    expect(resolveConductorApiKey()).toBe('from-env');
  });

  it('returns undefined when unset so SDK can use stored login', () => {
    delete process.env.CURSOR_API_KEY;
    expect(resolveConductorApiKey()).toBeUndefined();
  });

  it('preserves an explicit empty string', () => {
    expect(resolveConductorApiKey('')).toBe('');
  });
});
