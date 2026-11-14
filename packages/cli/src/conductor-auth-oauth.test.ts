import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type {
  ConductorAuthOptions,
  ConductorLoginResult,
  EnsembleConfig,
  ResolvedProfile,
} from '@agents-ensemble/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  getConductorAuthStatus: vi.fn(),
  isPiConductorOAuthProvider: vi.fn(),
  loadEnsembleConfig: vi.fn(),
  loadProfile: vi.fn(),
  loginConductor: vi.fn(),
  logoutConductor: vi.fn(),
  resolvePiConductorProvider: vi.fn(),
  resolveConductorAuthBackend: vi.fn(),
  resolveConductorPiResourcePaths: vi.fn(),
}));

vi.mock('@agents-ensemble/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agents-ensemble/core')>()),
  ...coreMocks,
}));

import { runConductorLogin } from './conductor-auth-command.js';

describe('Pi OAuth CLI interaction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    coreMocks.isPiConductorOAuthProvider.mockResolvedValue(true);
    coreMocks.loadProfile.mockResolvedValue({ profile: {} as ResolvedProfile });
    coreMocks.resolveConductorPiResourcePaths.mockReturnValue({
      agentDir: '/tmp/pi-auth-user',
      projectDir: '/tmp/pi-auth-project',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prints copyable URLs, device codes, selects a method, and hides a pasted code', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cli-pi-oauth-'));
    const config = {
      conductor: { model: 'default' },
      tui: { forceHyperlink: 'on' },
    } as EnsembleConfig;
    coreMocks.loadEnsembleConfig.mockResolvedValue(config);
    vi.stubEnv('FORCE_HYPERLINK', '0');

    await withStdio({
      onWrite(text, input) {
        if (text.includes('Select a login method')) {
          setImmediate(() => input.write('2\n'));
        } else if (text.includes('(input hidden): ')) {
          setImmediate(() => input.write('one-time-authorization-code\n'));
        }
      },
    }, async ({ stderrText, input }) => {
      coreMocks.loginConductor.mockImplementation(
        async (options: ConductorAuthOptions) => {
          const callbacks = options.oauthCallbacks!;
          callbacks.onAuth({
            url: 'https://auth.example.test/authorize?state=copy-me',
          });
          callbacks.onDeviceCode({
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://auth.example.test/device',
            intervalSeconds: 5,
            expiresInSeconds: 300,
          });
          const selected = await callbacks.onSelect({
            message: 'Choose a login method:',
            options: [
              { id: 'browser', label: 'Browser sign in' },
              { id: 'device', label: 'Device code' },
            ],
          });
          const code = await callbacks.onManualCodeInput?.({
            message: 'Paste the authorization code',
          });
          expect(selected).toBe('device');
          expect(code).toBe('one-time-authorization-code');
          return {
            backend: 'pi',
            provider: 'openai',
            method: 'oauth',
            authPath: '/tmp/pi-auth-user/auth.json',
          } satisfies ConductorLoginResult;
        },
      );

      await expect(
        runConductorLogin({
          repoRoot,
          backend: 'pi',
          provider: 'openai',
          authMethod: 'oauth',
        }),
      ).resolves.toMatchObject({ backend: 'pi', provider: 'openai', method: 'oauth' });

      const output = stderrText();
      expect(output).toContain('https://auth.example.test/authorize?state=copy-me');
      expect(output).toContain('https://auth.example.test/device');
      expect(output).toContain('Pi device code: ABCD-EFGH');
      expect(output).toContain('Expires in: 300s');
      expect(output).toContain('Check again every: 5s');
      expect(output).not.toContain('\u001b]8;;');
      expect(output).not.toContain('one-time-authorization-code');
      expect(input.isRaw).toBe(false);
    });
  });

  it('uses OSC 8 when FORCE_HYPERLINK explicitly enables it', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cli-pi-oauth-link-'));
    coreMocks.loadEnsembleConfig.mockResolvedValue({
      conductor: { model: 'default' },
      tui: { forceHyperlink: 'off' },
    } as EnsembleConfig);
    vi.stubEnv('FORCE_HYPERLINK', '1');
    coreMocks.loginConductor.mockImplementation(
      async (options: ConductorAuthOptions) => {
        options.oauthCallbacks!.onAuth({
          url: 'https://auth.example.test/authorize?state=copy-me',
        });
        return {
          backend: 'pi',
          provider: 'openai',
          method: 'oauth',
          authPath: '/tmp/pi-auth-user/auth.json',
        } satisfies ConductorLoginResult;
      },
    );

    await withStdio({}, async ({ stderrText }) => {
      await expect(
        runConductorLogin({
          repoRoot,
          backend: 'pi',
          provider: 'openai',
          authMethod: 'oauth',
        }),
      ).resolves.toMatchObject({ method: 'oauth' });

      expect(stderrText()).toContain(
        '\u001b]8;;https://auth.example.test/authorize?state=copy-me\u0007https://auth.example.test/authorize?state=copy-me\u001b]8;;\u0007',
      );
    });
  });

  it.each([
    ['Ctrl+C', '\u0003'],
    ['Ctrl+D', '\u0004'],
    ['Esc', '\u001b'],
  ])('cancels hidden code entry on %s and restores terminal echo mode', async (_key, inputKey) => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cli-pi-oauth-cancel-'));
    coreMocks.loadEnsembleConfig.mockResolvedValue({
      conductor: { model: 'default' },
      tui: { forceHyperlink: 'off' },
    } as EnsembleConfig);
    coreMocks.loginConductor.mockImplementation(
      async (options: ConductorAuthOptions) => {
        await options.oauthCallbacks!.onManualCodeInput?.({
          message: 'Paste the authorization code',
        });
        return {
          backend: 'pi',
          provider: 'openai',
          method: 'oauth',
          authPath: '/tmp/pi-auth-user/auth.json',
        } satisfies ConductorLoginResult;
      },
    );

    await withStdio({
      onWrite(text, input) {
        if (text.includes('(input hidden): ')) {
          setImmediate(() => input.write(inputKey));
        }
      },
    }, async ({ input }) => {
      await expect(
        runConductorLogin({
          repoRoot,
          backend: 'pi',
          provider: 'openai',
          authMethod: 'oauth',
        }),
      ).rejects.toThrow('Pi OAuth login cancelled.');
      expect(input.isRaw).toBe(false);
    });
  });

  it('aborts a pending manual-code prompt when Pi cancels that prompt', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cli-pi-oauth-abort-'));
    coreMocks.loadEnsembleConfig.mockResolvedValue({
      conductor: { model: 'default' },
      tui: { forceHyperlink: 'off' },
    } as EnsembleConfig);
    coreMocks.loginConductor.mockImplementation(
      async (options: ConductorAuthOptions) => {
        const controller = new AbortController();
        const pending = options.oauthCallbacks!.onManualCodeInput?.({
          message: 'Paste the authorization code',
          signal: controller.signal,
        });
        setImmediate(() => controller.abort());
        await pending;
        return {
          backend: 'pi',
          provider: 'openai',
          method: 'oauth',
          authPath: '/tmp/pi-auth-user/auth.json',
        } satisfies ConductorLoginResult;
      },
    );

    await withStdio({}, async ({ input }) => {
      await expect(
        runConductorLogin({
          repoRoot,
          backend: 'pi',
          provider: 'openai',
          authMethod: 'oauth',
        }),
      ).rejects.toThrow('Pi OAuth login cancelled.');
      expect(input.isRaw).toBe(false);
    });
  });

  it('gives Pi credential guidance and does not start OAuth outside a TTY', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cli-pi-oauth-nontty-'));
    coreMocks.loadEnsembleConfig.mockResolvedValue({
      conductor: { model: 'default' },
      tui: { forceHyperlink: 'auto' },
    } as EnsembleConfig);

    await withStdio({ isTTY: false }, async () => {
      await expect(
        runConductorLogin({
          repoRoot,
          backend: 'pi',
          provider: 'openai',
          authMethod: 'oauth',
        }),
      ).rejects.toThrow(/interactive TTY.*Pi credentials.*auth\.json/);
      expect(coreMocks.loginConductor).not.toHaveBeenCalled();
    });
  });

  it('keeps Cursor login on its existing SDK path without the Pi TTY gate', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cli-cursor-auth-login-'));
    coreMocks.loadEnsembleConfig.mockResolvedValue({
      conductor: { model: 'default' },
      tui: { forceHyperlink: 'auto' },
    } as EnsembleConfig);
    const result = {
      email: 'operator@example.test',
      apiKeyExpiresAtMs: 1234,
    } as ConductorLoginResult;
    coreMocks.loginConductor.mockResolvedValue(result);

    await withStdio({ isTTY: false }, async () => {
      await expect(
        runConductorLogin({ repoRoot, backend: 'cursor' }),
      ).resolves.toBe(result);
      expect(coreMocks.loginConductor).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'cursor' }),
      );
      expect(coreMocks.isPiConductorOAuthProvider).not.toHaveBeenCalled();
    });
  });
});

interface TestInput extends PassThrough {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): this;
}

async function withStdio<T>(
  options: {
    isTTY?: boolean;
    onWrite?: (text: string, input: TestInput) => void;
  },
  run: (stdio: {
    input: TestInput;
    stderrText: () => string;
  }) => Promise<T>,
): Promise<T> {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
  const input = new PassThrough() as TestInput;
  input.isTTY = options.isTTY ?? true;
  input.isRaw = false;
  input.setRawMode = function setRawMode(mode: boolean) {
    this.isRaw = mode;
    return this;
  };
  let output = '';
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      output += text;
      options.onWrite?.(text, input);
      callback();
    },
  }) as Writable & { isTTY: boolean };
  stderr.isTTY = true;

  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: true,
    value: input,
  });
  Object.defineProperty(process, 'stderr', {
    configurable: true,
    enumerable: true,
    value: stderr,
  });

  try {
    return await run({ input, stderrText: () => output });
  } finally {
    if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    if (originalStderr) Object.defineProperty(process, 'stderr', originalStderr);
    input.destroy();
    stderr.destroy();
  }
}
