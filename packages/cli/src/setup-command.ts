import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  resolveConductorPiResourcePaths,
  resolvePiResourceRoots,
  writeConductorSetupFiles,
  type ConductorBackend,
  type ConductorLoginResult,
  type ConductorSetupFiles,
} from '@agents-ensemble/core';
import {
  resolveConductorCommandContext,
  runConductorLogin,
  type ConductorCommandOptions,
  type ResolvedConductorCommandContext,
} from './conductor-auth-command.js';

export const SETUP_OPENAI_PROVIDER = 'openai';
export const SETUP_OPENAI_MODEL_ID = 'gpt-6.1-sol';

type SetupAuthMethod = 'api_key' | 'oauth';

export interface SetupCommandOptions {
  repoRoot?: string;
  input?: Readable & { isTTY?: boolean };
  promptOutput?: Writable;
  stdout?: Writable;
  resolveContext?: (
    options?: ConductorCommandOptions,
  ) => Promise<ResolvedConductorCommandContext>;
  writeFiles?: typeof writeConductorSetupFiles;
  login?: typeof runConductorLogin;
}

export interface SetupCommandResult {
  backend: ConductorBackend;
  authMethod?: SetupAuthMethod;
  files: ConductorSetupFiles;
  login: ConductorLoginResult;
  warnings: string[];
}

const SETUP_GUIDE =
  'https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md';

export async function runSetupCommand(
  options: SetupCommandOptions = {},
): Promise<SetupCommandResult> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const input = options.input ?? process.stdin;
  const promptOutput = options.promptOutput ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const resolveContext = options.resolveContext ?? resolveConductorCommandContext;
  const writeFiles = options.writeFiles ?? writeConductorSetupFiles;
  const login = options.login ?? runConductorLogin;

  if (!input.isTTY) {
    throw new Error(
      '`ensemble setup` requires an interactive TTY. For CI or a headless host, set `conductor.backend` in `~/.ensemble/config.yaml`; for Pi, also set `defaultProvider` and `defaultModel` in `~/.ensemble/pi/settings.json`, then run `ensemble auth login`. See ' +
        SETUP_GUIDE,
    );
  }

  promptOutput.write(
    '\nConductor の初期設定を行います。設定は user 層に保存します。\n',
  );
  const backendChoice = await promptChoice(
    'Conductor backend を選んでください。',
    ['Pi（OpenAI / 推奨）', 'Cursor'],
    input,
    promptOutput,
  );
  const backend: ConductorBackend = backendChoice === 0 ? 'pi' : 'cursor';

  let authMethod: SetupAuthMethod | undefined;
  let pi: { provider: string; modelId: string } | undefined;
  let protectedProjectPiDir: string | undefined;
  if (backend === 'pi') {
    authMethod =
      (await promptChoice(
        'OpenAI の認証方法を選んでください。',
        ['OAuth（ChatGPT アカウント）', 'API key（OpenAI API）'],
        input,
        promptOutput,
      )) === 0
        ? 'oauth'
        : 'api_key';
    pi = {
      provider: SETUP_OPENAI_PROVIDER,
      modelId: SETUP_OPENAI_MODEL_ID,
    };

    const currentPiContext = await resolveContext({
      repoRoot,
      backend: 'pi',
    });
    protectedProjectPiDir = currentPiContext.auth.pi?.pi?.projectDir;
  }

  const files = await writeFiles({
    repoRoot,
    backend,
    ...(pi ? { pi } : {}),
    ...(protectedProjectPiDir
      ? { readonlyProjectPiDir: protectedProjectPiDir }
      : {}),
  });
  const loginOptions: ConductorCommandOptions = {
    repoRoot,
    backend,
    ...(files.pi
      ? {
          piAgentDir: files.pi.agentDir,
          provider: files.pi.provider,
          modelId: files.pi.modelId,
          authMethod,
        }
      : {}),
  };

  let loginResult: ConductorLoginResult;
  try {
    loginResult = await login(loginOptions);
  } catch (error) {
    throw new Error(
      `設定は保存しましたが、認証に失敗しました。設定を残したまま再試行できます: ${errorMessage(error)}\n` +
        (backend === 'pi'
          ? '`ensemble setup` を再実行して認証方法を選ぶか、`ensemble auth login --provider openai` を実行してください。'
          : '`ensemble setup` を再実行して Cursor login を行ってください。'),
    );
  }

  stdout.write(`初期設定を保存しました: ${files.configPath}\n`);
  if (files.pi) {
    stdout.write(`Pi 設定: ${files.pi.settingsPath}\n`);
  }
  stdout.write(formatLoginSuccess(loginResult));

  const effectiveContext = await resolveContext({ repoRoot });
  const warnings = await collectSetupWarnings({
    repoRoot,
    backend,
    files,
    effectiveContext,
  });
  for (const warning of warnings) {
    promptOutput.write(`注意: ${warning}\n`);
  }

  return {
    backend,
    ...(authMethod ? { authMethod } : {}),
    files,
    login: loginResult,
    warnings,
  };
}

async function promptChoice(
  question: string,
  choices: string[],
  input: Readable,
  output: Writable,
  defaultIndex = 0,
): Promise<number> {
  const readline = createInterface({ input, output });
  try {
    output.write(`\n${question}\n`);
    choices.forEach((choice, index) => {
      output.write(`  ${index + 1}) ${choice}${index === defaultIndex ? '（既定）' : ''}\n`);
    });
    while (true) {
      const answer = (await readline.question(
        `選択 [1-${choices.length}, Enter=${defaultIndex + 1}]: `,
      )).trim();
      if (!answer) return defaultIndex;
      const selected = Number.parseInt(answer, 10) - 1;
      if (
        Number.isInteger(selected) &&
        selected >= 0 &&
        selected < choices.length &&
        String(selected + 1) === answer
      ) {
        return selected;
      }
      output.write(`1 から ${choices.length} の番号を入力してください。\n`);
    }
  } finally {
    readline.close();
  }
}

async function collectSetupWarnings(options: {
  repoRoot: string;
  backend: ConductorBackend;
  files: ConductorSetupFiles;
  effectiveContext: ResolvedConductorCommandContext;
}): Promise<string[]> {
  const warnings: string[] = [];
  if (options.effectiveContext.auth.backend !== options.backend) {
    warnings.push(
      `user 設定には backend=${options.backend} を保存しましたが、この repository で有効な backend は ${options.effectiveContext.auth.backend} です。project config または選択中 profile の設定が優先されています。`,
    );
  }

  if (options.backend !== 'pi' || !options.files.pi) return warnings;

  const configuredModel = options.effectiveContext.auth.modelId;
  if (configuredModel && configuredModel !== options.files.pi.modelId) {
    warnings.push(
      `既存の conductor.model=${configuredModel} が Pi settings の defaultModel より優先されます。user 設定は変更していません。`,
    );
  }

  const roots = resolveConductorPiResourcePaths({
    repoRoot: options.repoRoot,
    config: options.effectiveContext.config,
  });
  const effectivePiRoots = resolvePiResourceRoots({
    cwd: options.repoRoot,
    pi: roots,
  });
  if (resolve(effectivePiRoots.agentDir) !== resolve(options.files.pi.agentDir)) {
    warnings.push(
      `この repository で有効な conductor.pi.agentDir は ${effectivePiRoots.agentDir} です。setup は user 層の ${options.files.pi.agentDir} に保存しました。`,
    );
  }
  const projectSettingsPath = join(roots.projectDir, 'settings.json');
  let projectSettings: unknown;
  try {
    projectSettings = JSON.parse(await readFile(projectSettingsPath, 'utf8'));
  } catch {
    projectSettings = undefined;
  }
  if (isRecord(projectSettings)) {
    const providerOverride =
      typeof projectSettings.defaultProvider === 'string' &&
      projectSettings.defaultProvider !== options.files.pi.provider;
    const modelOverride =
      typeof projectSettings.defaultModel === 'string' &&
      projectSettings.defaultModel !== options.files.pi.modelId;
    if (providerOverride || modelOverride) {
      warnings.push(
        `project Pi settings (${projectSettingsPath}) に異なる defaultProvider / defaultModel があり、user Pi 設定より優先されます。project ファイルは変更していません。`,
      );
    }
  }

  const projectAuthPath = join(roots.projectDir, 'auth.json');
  let projectAuth: unknown;
  try {
    projectAuth = JSON.parse(await readFile(projectAuthPath, 'utf8'));
  } catch {
    return warnings;
  }
  if (isRecord(projectAuth) && Object.hasOwn(projectAuth, options.files.pi.provider)) {
    warnings.push(
      `project Pi auth.json (${projectAuthPath}) に ${options.files.pi.provider} の認証情報があります。project credential は user login より優先されます。project ファイルは変更していません。`,
    );
  }
  return warnings;
}

function formatLoginSuccess(result: ConductorLoginResult): string {
  if ('method' in result) {
    return `ログイン済み: Pi / ${result.provider} (${result.method}); auth.json: ${result.authPath}\n`;
  }
  return `ログイン済み: Cursor${result.email ? ` / ${result.email}` : ''}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
