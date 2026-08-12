import { afterEach, describe, expect, it } from 'vitest';
import {
  CONDUCTOR_MODEL_ID_ENV,
  resolveConductorModelId,
} from './resolve-conductor-model-id.js';

describe('resolveConductorModelId', () => {
  const original = process.env[CONDUCTOR_MODEL_ID_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[CONDUCTOR_MODEL_ID_ENV];
    } else {
      process.env[CONDUCTOR_MODEL_ID_ENV] = original;
    }
  });

  it('prefers an explicit model id', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'from-env';
    expect(resolveConductorModelId('composer-2.5')).toBe('composer-2.5');
  });

  it('normalizes auto to default', () => {
    expect(resolveConductorModelId('auto')).toBe('default');
  });

  it('falls back to CONDUCTOR_MODEL_ID when explicit is omitted', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'composer-2.5';
    expect(resolveConductorModelId()).toBe('composer-2.5');
  });

  it('normalizes auto from CONDUCTOR_MODEL_ID', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'auto';
    expect(resolveConductorModelId()).toBe('default');
  });

  it('falls back to default when unset', () => {
    delete process.env[CONDUCTOR_MODEL_ID_ENV];
    expect(resolveConductorModelId()).toBe('default');
  });

  it('treats an explicit empty string as unset', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'from-env';
    expect(resolveConductorModelId('')).toBe('from-env');
  });
});
