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
  /** Select API-key login and use the hidden TTY prompt for mixed-mode providers. */
  apiKeyPrompt?: boolean;
  /** Read a Pi API key from non-TTY stdin instead of prompting. */
  apiKeyStdin?: boolean;
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
  if (options.apiKeyStdin && context.auth.backend !== 'pi') {
    throw new Error('--api-key-stdin is available only with the Pi backend.');
  }
  if (options.apiKeyPrompt && context.auth.backend !== 'pi') {
    throw new Error('--api-key-prompt is available only with the Pi backend.');
  }
  if (options.apiKeyPrompt && options.apiKeyStdin) {
    throw new Error('Choose either --api-key-prompt or --api-key-stdin.');
  }
  if (options.apiKeyStdin && options.authMethod === 'oauth') {
    throw new Error('--api-key-stdin cannot be combined with OAuth login.');
  }
  if (options.apiKeyPrompt && options.authMethod === 'oauth') {
    throw new Error('--api-key-prompt cannot be combined with OAuth login.');
  }
  if (options.apiKeyPrompt && !process.stdin.isTTY) {
    throw new Error(
      '--api-key-prompt requires a TTY. Use --api-key-stdin with piped input for non-interactive login.',
    );
  }
  if (options.apiKeyStdin && process.stdin.isTTY) {
    throw new Error(
      '--api-key-stdin requires piped standard input. Run without this option to use the hidden TTY prompt.',
    );
  }
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
  const useApiKey =
    options.apiKeyPrompt ||
    options.apiKeyStdin ||
    options.authMethod === 'api_key';
  if (oauth && !useApiKey) {
    requireInteractiveTty(
      'Pi OAuth login',
      'Run from a TTY to complete OAuth, or use --api-key-stdin to store an API key instead.',
    );
    return loginConductor({
      ...context.auth,
      oauthCallbacks: createOAuthLoginCallbacks(),
    });
  }

  const provider = options.provider ?? (await resolvePiConductorProvider(providerOptions));
  const apiKey = options.apiKeyStdin
    ? await readApiKeyFromStdin()
    : await promptSecret(`Pi API key for ${provider}: `);
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

function requireInteractiveTty(operation: string, nonTtyGuidance?: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${operation} requires a TTY. ${nonTtyGuidance ?? 'Run it from an interactive terminal (SSH is supported), or configure Pi auth.json/environment credentials manually.'}`,
    );
  }
}

async function promptSecret(prompt: string): Promise<string> {
  requireInteractiveTty(
    'Pi API-key login',
    'For non-interactive login, pass the key through stdin with --api-key-stdin. A provider-specific environment variable can supply request-time credentials without saving them to auth.json.',
  );
  const input = process.stdin;
  const output = process.stderr;
  return new Promise<string>((resolveAnswer, reject) => {
    let answer = '';
    let settled = false;

    const cleanup = () => {
      input.off('data', onData);
      if (input.setRawMode) input.setRawMode(false);
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
        if (character === '\u0003') {
          finish(new Error('Pi API-key login cancelled.'));
        } else if (character === '\r' || character === '\n') {
          finish();
        } else if (character === '\u007f' || character === '\b') {
          answer = answer.slice(0, -1);
        } else if (character >= ' ') {
          answer += character;
        }
      }
    };

    output.write(prompt);
    input.resume();
    if (input.setRawMode) input.setRawMode(true);
    input.on('data', onData);
  });
}

async function readApiKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const apiKey = Buffer.concat(chunks).toString('utf8').trim();
  if (!apiKey) {
    throw new Error(
      'No API key was received on stdin. Pipe a provider API key to `ensemble auth login --api-key-stdin`.',
    );
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new Error('Standard input must contain a single API key.');
  }
  return apiKey;
}

function createOAuthLoginCallbacks(): OAuthLoginCallbacks {
  const write = (message: string) => {
    process.stderr.write(`${message}\n`);
  };
  return {
    onAuth: (info) => {
      write(`Open this URL to authenticate Pi: ${info.url}`);
      if (info.instructions) write(info.instructions);
    },
    onDeviceCode: (info) => {
      write(`Pi device code: ${info.userCode}`);
      write(`Verification URL: ${info.verificationUri}`);
      if (info.expiresInSeconds) write(`Expires in: ${info.expiresInSeconds}s`);
    },
    onProgress: write,
    onPrompt: (prompt) => promptLine(prompt.message),
    onManualCodeInput: () => promptLine('Enter the authorization code: '),
    onSelect: async (prompt) => {
      write(prompt.message);
      prompt.options.forEach((option, index) => write(`${index + 1}) ${option.label}`));
      const answer = await promptLine('Select a login method: ');
      const index = Number.parseInt(answer, 10) - 1;
      return Number.isInteger(index) && prompt.options[index]
        ? prompt.options[index]!.id
        : undefined;
    },
  };
}

async function promptLine(prompt: string): Promise<string> {
  requireInteractiveTty(
    'Pi OAuth login',
    'Run from a TTY to complete OAuth, or use --api-key-stdin to store an API key instead.',
  );
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolveAnswer) => {
      readline.question(prompt, resolveAnswer);
    });
  } finally {
    readline.close();
  }
}

function redactSecret(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.replaceAll(secret, '[redacted]') : message;
}
