import { accessSync, constants } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureCursorSdkRipgrepPath,
  resolveBundledSdkRipgrepPath,
} from './configure-cursor-sdk-env.js';

const RIPGREP_ENV = 'CURSOR_RIPGREP_PATH';

describe('configure-cursor-sdk-env', () => {
  const original = process.env[RIPGREP_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[RIPGREP_ENV];
    } else {
      process.env[RIPGREP_ENV] = original;
    }
  });

  it('resolves bundled sdk platform rg when installed', () => {
    const bundled = resolveBundledSdkRipgrepPath();
    if (!bundled) {
      // optional platform package may be absent in CI for other arches
      return;
    }
    expect(bundled).toMatch(/[/\\]bin[/\\]rg(\.exe)?$/);
    accessSync(bundled, constants.X_OK);
  });

  it('does not overwrite an absolute CURSOR_RIPGREP_PATH', () => {
    process.env[RIPGREP_ENV] = '/custom/rg';
    expect(ensureCursorSdkRipgrepPath()).toBe('/custom/rg');
  });

  it('seeds CURSOR_RIPGREP_PATH from bundled rg when unset', () => {
    delete process.env[RIPGREP_ENV];
    const resolved = ensureCursorSdkRipgrepPath();
    if (!resolved) {
      return;
    }
    expect(process.env[RIPGREP_ENV]).toBe(resolved);
    accessSync(resolved, constants.X_OK);
  });
});
