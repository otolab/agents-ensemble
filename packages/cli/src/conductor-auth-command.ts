import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  getConductorAuthStatus,
  isPiConductorOAuthProvider,
  loadEnsembleConfig,
  loadProfile,
  loginConductor,
  logoutConductor,
  resolvePiConductorProvider,
  resolveConductorAuthBackend,
  resolveConductorPiResourcePaths,
  type ConductorAuthOptions,
  type ConductorAuthStatus,
  type ConductorLoginResult,
  type ConductorLogoutResult,
  type ConductorBackend,
  type EnsembleConfig,
  type ResolvedProfile,
} from '@agents-ensemble/core';
import {
  formatOsc8Hyperlink,
  resolveTuiIssueLinkMode,
} from './tui/format-operator-context.js';

type OAuthLoginCallbacks = NonNullable<ConductorAuthOptions['oauthCallbacks']>;

export interface ConductorCommandOptions {
  repoRoot?: string;
  profile?: string;
  provider?: string;
  modelId?: string;
  /** Internal override used by setup to log in to the backend just selected. */
  backend?: ConductorBackend;
  /** User Pi root selected by setup, kept separate from project Pi resources. */
  piAgentDir?: string;
  /** Explicit Pi login choice used by setup; ordinary auth login keeps its current default. */
  authMethod?: 'api_key' | 'oauth';
}

export interface ResolvedConductorCommandContext {
  repoRoot: string;
  config: EnsembleConfig;
  profile: ResolvedProfile;
  auth: ConductorAuthOptions;
}

export async function resolveConductorCommandContext(
  options: ConductorCommandOptions = {},
): Promise<ResolvedConductorCommandContext> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const config = await loadEnsembleConfig(repoRoot);
  const profile = (
    await loadProfile({
      profile: options.profile,
      cwd: repoRoot,
      config,
    })
  ).profile;
  const backend =
    options.backend ?? resolveConductorAuthBackend({ profile, config });
  const configuredModel =
    config.conductor.model !== 'default' && config.conductor.model !== 'auto'
      ? config.conductor.model
      : undefined;
  const pi =
    backend === 'pi'
      ? {
          cwd: repoRoot,
          pi: {
            ...resolveConductorPiResourcePaths({ repoRoot, config }),
            ...(options.piAgentDir ? { agentDir: options.piAgentDir } : {}),
          },
        }
      : undefined;

  return {
    repoRoot,
    config,
    profile,
    auth: {
      backend,
      profile,
      config,
      ...(pi ? { pi } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelId ?? configuredModel
        ? { modelId: options.modelId ?? configuredModel }
        : {}),
    },
  };
}

export async function runConductorLogin(
  options: ConductorCommandOptions = {},
): Promise<ConductorLoginResult> {
  const context = await resolveConductorCommandContext(options);
  if (context.auth.backend !== 'pi') {
    return loginConductor(context.auth);
  }

  const piOptions = context.auth.pi!;
  const providerOptions = {
    ...piOptions,
    ...(context.auth.modelId ? { modelId: context.auth.modelId } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
  };
  const oauth = await isPiConductorOAuthProvider(providerOptions);
  if (options.authMethod === 'oauth' && !oauth) {
    throw new Error(
      `Pi provider does not support OAuth. Choose API key or another provider.`,
    );
  }
  if (oauth && options.authMethod !== 'api_key') {
    requireInteractiveTty('Pi OAuth login');
    return loginConductor({
      ...context.auth,
      oauthCallbacks: createOAuthLoginCallbacks(context.config),
    });
  }

  const provider = options.provider ?? (await resolvePiConductorProvider(providerOptions));
  const apiKey = await promptSecret(`Pi API key for ${provider}: `);
  try {
    return await loginConductor({
      ...context.auth,
      provider,
      apiKey,
    });
  } catch (error) {
    throw new Error(redactSecret(error, apiKey));
  }
}

export async function runConductorLogout(
  options: ConductorCommandOptions = {},
): Promise<ConductorLogoutResult> {
  const context = await resolveConductorCommandContext(options);
  return logoutConductor(context.auth);
}

export async function runConductorAuthStatus(
  options: ConductorCommandOptions = {},
): Promise<ConductorAuthStatus> {
  const context = await resolveConductorCommandContext(options);
  return getConductorAuthStatus(context.auth);
}

function requireInteractiveTty(operation: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${operation} requires an interactive TTY. Run it from an SSH or tmux terminal, or configure Pi credentials in the user auth.json or provider environment manually.`,
    );
  }
}

async function promptSecret(prompt: string): Promise<string> {
  requireInteractiveTty('Pi API-key login');
  return promptHiddenInput(prompt, 'Pi API-key login cancelled.');
}

async function promptHiddenInput(
  prompt: string,
  cancelMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new Error(cancelMessage);
  }
  const input = process.stdin;
  const output = process.stderr;
  if (!input.setRawMode) {
    throw new Error('Pi login requires a TTY that supports hidden input.');
  }
  return new Promise<string>((resolveAnswer, reject) => {
    let answer = '';
    let settled = false;
    const previousRawMode = input.isRaw === true;

    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      try {
        input.setRawMode(previousRawMode);
      } catch {
        // Preserve the prompt result while still attempting to restore the TTY.
      }
      input.pause();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      if (error) reject(error);
      else resolveAnswer(answer);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (settled) break;
        if (
          character === '\u0003' ||
          character === '\u0004' ||
          character === '\u001b'
        ) {
          finish(new Error(cancelMessage));
        } else if (character === '\r' || character === '\n') {
          finish();
        } else if (character === '\u007f' || character === '\b') {
          answer = Array.from(answer).slice(0, -1).join('');
        } else if (character >= ' ') {
          answer += character;
        }
      }
    };
    const onEnd = () => finish(new Error(cancelMessage));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(new Error(cancelMessage));

    output.write(prompt);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      input.setRawMode(true);
      input.resume();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function createOAuthLoginCallbacks(config: EnsembleConfig): OAuthLoginCallbacks {
  const write = (message: string) => {
    process.stderr.write(`${message}\n`);
  };
  const formatUrl = (url: string) =>
    resolveTuiIssueLinkMode({ config }) === 'osc8'
      ? formatOsc8Hyperlink(url, url)
      : url;
  return {
    onAuth: (info) => {
      write('Open this URL in a browser to authenticate Pi:');
      write(formatUrl(info.url));
      if (info.instructions) write(info.instructions);
    },
    onDeviceCode: (info) => {
      write(`Pi device code: ${info.userCode}`);
      write(`Verification URL: ${formatUrl(info.verificationUri)}`);
      write('Open the verification URL on a device with a browser and enter the code above.');
      if (info.expiresInSeconds) write(`Expires in: ${info.expiresInSeconds}s`);
      if (info.intervalSeconds) write(`Check again every: ${info.intervalSeconds}s`);
    },
    onProgress: write,
    onPrompt: (prompt) =>
      prompt.type === 'secret' || prompt.type === 'manual_code'
        ? promptHiddenInput(
            `${prompt.message} (input hidden): `,
            'Pi OAuth login cancelled.',
            prompt.signal,
          )
        : promptLine(`${prompt.message}: `, prompt.signal),
    onManualCodeInput: (prompt) =>
      promptHiddenInput(
        `${prompt?.message ?? 'Enter the authorization code'} (input hidden): `,
        'Pi OAuth login cancelled.',
        prompt?.signal,
      ),
    onSelect: async (prompt) => {
      write(prompt.message);
      prompt.options.forEach((option, index) => write(`${index + 1}) ${option.label}`));
      if (prompt.options.length === 0) return undefined;
      while (true) {
        const answer = await promptLine(
          'Select a login method (Enter to cancel): ',
          prompt.signal,
        );
        if (!answer.trim()) return undefined;
        const index = Number(answer.trim()) - 1;
        if (Number.isInteger(index) && prompt.options[index]) {
          return prompt.options[index]!.id;
        }
        write(`Enter a number from 1 to ${prompt.options.length}, or press Enter to cancel.`);
      }
    },
  };
}

async function promptLine(
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  requireInteractiveTty('Pi OAuth login');
  if (signal?.aborted) {
    throw new Error('Pi OAuth login cancelled.');
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolveAnswer, reject) => {
      let settled = false;
      const cleanup = () => {
        readline.off('SIGINT', onInterrupt);
        readline.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error?: Error, answer?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolveAnswer(answer ?? '');
      };
      const onInterrupt = () =>
        finish(new Error('Pi OAuth login cancelled.'));
      const onClose = () => finish(new Error('Pi OAuth login cancelled.'));
      const onAbort = () => finish(new Error('Pi OAuth login cancelled.'));

      readline.once('SIGINT', onInterrupt);
      readline.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      readline.question(prompt, (answer) => finish(undefined, answer));
    });
  } finally {
    readline.close();
  }
}

function redactSecret(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.replaceAll(secret, '[redacted]') : message;
}
