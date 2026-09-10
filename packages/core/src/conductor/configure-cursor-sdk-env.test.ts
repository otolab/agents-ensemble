import {
  accessSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockConfigureCursorSdk } = vi.hoisted(() => ({
  mockConfigureCursorSdk: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  configureCursorSdk: mockConfigureCursorSdk,
}));

import {
  ensureCursorSdkProxy,
  ensureCursorSdkRipgrepPath,
  readCursorSettings,
  resolveBundledSdkRipgrepPath,
  resolveCursorSettingsPath,
} from './configure-cursor-sdk-env.js';

const RIPGREP_ENV = 'CURSOR_RIPGREP_PATH';

describe('configure-cursor-sdk-env', () => {
  const original = process.env[RIPGREP_ENV];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[RIPGREP_ENV];
    } else {
      process.env[RIPGREP_ENV] = original;
    }
    mockConfigureCursorSdk.mockReset();
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  function createSettingsFile(contents: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'agents-ensemble-cursor-'));
    temporaryDirectories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    writeFileSync(settingsPath, contents);
    return settingsPath;
  }

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

  it('resolves the platform-specific Cursor settings path', () => {
    expect(
      resolveCursorSettingsPath({
        platform: 'darwin',
        homeDir: '/Users/example',
      }),
    ).toBe(
      join(
        '/Users/example',
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'settings.json',
      ),
    );
    expect(
      resolveCursorSettingsPath({
        platform: 'linux',
        homeDir: '/home/example',
      }),
    ).toBe(join('/home/example', '.config', 'Cursor', 'User', 'settings.json'));
    expect(
      resolveCursorSettingsPath({
        platform: 'win32',
        appData: 'C:\\Users\\example\\AppData\\Roaming',
      }),
    ).toBe(
      join(
        'C:\\Users\\example\\AppData\\Roaming',
        'Cursor',
        'User',
        'settings.json',
      ),
    );
  });

  it('reads JSONC Cursor settings', () => {
    const settingsPath = createSettingsFile(`
      {
        // Cursor settings allow comments and trailing commas.
        "http": {
          "proxy": "http://proxy.example:8080",
          "noProxy": ["localhost", "127.0.0.1"],
        },
        "cursor": {
          "general": {
            "disableHttp2": true,
          },
        },
      }
    `);

    expect(readCursorSettings(settingsPath)).toEqual({
      http: {
        proxy: 'http://proxy.example:8080',
        noProxy: ['localhost', '127.0.0.1'],
      },
      cursor: {
        general: {
          disableHttp2: true,
        },
      },
    });
  });

  it('maps Cursor proxy settings and disables HTTP/2 when requested', () => {
    const settingsPath = createSettingsFile(
      JSON.stringify({
        http: {
          proxy: 'http://proxy.example:8080',
          noProxy: 'localhost,127.0.0.1',
        },
        cursor: { general: { disableHttp2: true } },
      }),
    );
    const env = {} as NodeJS.ProcessEnv;

    ensureCursorSdkProxy({ env, settingsPath });

    expect(env).toMatchObject({
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    expect(mockConfigureCursorSdk).toHaveBeenCalledWith({
      local: { useHttp1ForAgent: true },
    });
  });

  it('keeps existing environment values ahead of Cursor settings', () => {
    const settingsPath = createSettingsFile(
      JSON.stringify({
        http: {
          proxy: 'http://settings-proxy.example:8080',
          noProxy: 'settings.example',
        },
      }),
    );
    const env = {
      HTTP_PROXY: 'http://shell-proxy.example:8080',
      HTTPS_PROXY: 'http://shell-secure-proxy.example:8080',
      NO_PROXY: 'shell.example',
    } as NodeJS.ProcessEnv;

    ensureCursorSdkProxy({ env, settingsPath });

    expect(env.HTTP_PROXY).toBe('http://shell-proxy.example:8080');
    expect(env.HTTPS_PROXY).toBe('http://shell-secure-proxy.example:8080');
    expect(env.NO_PROXY).toBe('shell.example');
    expect(mockConfigureCursorSdk).not.toHaveBeenCalled();
  });

  it('treats lowercase proxy variables as existing environment values', () => {
    const settingsPath = createSettingsFile(
      JSON.stringify({
        http: { proxy: 'http://settings-proxy.example:8080' },
      }),
    );
    const env = {
      http_proxy: 'http://shell-proxy.example:8080',
    } as NodeJS.ProcessEnv;

    ensureCursorSdkProxy({ env, settingsPath });

    expect(env.http_proxy).toBe('http://shell-proxy.example:8080');
    expect(env.HTTP_PROXY).toBe('http://shell-proxy.example:8080');
    expect(env.HTTPS_PROXY).toBe('http://settings-proxy.example:8080');
  });

  it('leaves the environment unchanged when settings are unavailable', () => {
    const env = {
      HTTP_PROXY: 'http://shell-proxy.example:8080',
    } as NodeJS.ProcessEnv;

    ensureCursorSdkProxy({
      env,
      settingsPath: join(
        tmpdir(),
        'agents-ensemble-settings-does-not-exist.json',
      ),
    });

    expect(env).toEqual({ HTTP_PROXY: 'http://shell-proxy.example:8080' });
    expect(mockConfigureCursorSdk).not.toHaveBeenCalled();
  });
});
