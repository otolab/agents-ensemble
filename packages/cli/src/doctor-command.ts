import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import {
  createConductorAgentFactory,
  hasConductorAuth,
  isConductorAuthError,
  resolveConductorReasoning,
  resolveWorkerAcpSpawn,
  validateAcpPresetPrerequisites,
  readDoctorConfigSettings,
  escapeTerminalControlCharacters,
  type ConductorAgentCreateOptions,
  type ConductorAgentFactory,
  type DoctorConfigLayer,
  type DoctorConfigSettingSnapshot,
  type DoctorConfigWriteProposal,
  type ResolvedAcpSpawn,
} from '@agents-ensemble/core';
import {
  resolveConductorCommandContext,
  type ConductorCommandOptions,
  type ResolvedConductorCommandContext,
} from './conductor-auth-command.js';
import { createDoctorConfigTools } from './doctor/doctor-config-tools.js';
import {
  DOCTOR_INITIAL_PROMPT,
  DOCTOR_SYSTEM_PROMPT,
} from './doctor/doctor-materials.js';

export interface DoctorCommandOptions {
  repoRoot?: string;
  project?: boolean;
  input?: Readable & { isTTY?: boolean };
  promptOutput?: Writable & { isTTY?: boolean };
  stdout?: Writable;
  resolveContext?: (
    options?: ConductorCommandOptions,
  ) => Promise<ResolvedConductorCommandContext>;
  authCheck?: typeof hasConductorAuth;
  createAgentFactory?: (backend: 'cursor' | 'pi') => ConductorAgentFactory;
  readSettings?: typeof readDoctorConfigSettings;
  resolveWorkerSpawn?: typeof resolveWorkerAcpSpawn;
  validateWorkerSpawn?: typeof validateAcpPresetPrerequisites;
}

const NO_AUTH_GUIDANCE =
  'Conductor 認証が見つかりません。`ensemble setup` で初期設定するか、設定を確認して `ensemble auth login` を実行してください。状態確認: `ensemble auth status`。秘密値を doctor に入力しないでください。worker CLI の認証は ADR 0028 に従い各 CLI に移譲されます。';

export async function runDoctorCommand(
  options: DoctorCommandOptions = {},
): Promise<void> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const resolveContext = options.resolveContext ?? resolveConductorCommandContext;
  const authCheck = options.authCheck ?? hasConductorAuth;
  const createAgentFactory =
    options.createAgentFactory ?? createConductorAgentFactory;
  const readSettings = options.readSettings ?? readDoctorConfigSettings;
  const resolveWorkerSpawn = options.resolveWorkerSpawn ?? resolveWorkerAcpSpawn;
  const validateWorkerSpawn =
    options.validateWorkerSpawn ?? validateAcpPresetPrerequisites;
  const input = options.input ?? process.stdin;
  const promptOutput = options.promptOutput ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;

  const context = await resolveContext({ repoRoot });
  if (!authCheck(context.auth)) {
    throw new Error(NO_AUTH_GUIDANCE);
  }
  if (input.isTTY !== true || promptOutput.isTTY !== true) {
    throw new Error(
      '`ensemble doctor` requires an interactive TTY. Conductor authentication is ready; rerun doctor from a terminal.',
    );
  }

  const configSnapshot = await readSettings({ repoRoot });
  const workerStatus = resolveWorkerPreflight(
    context,
    resolveWorkerSpawn,
    validateWorkerSpawn,
  );
  writeInitialReport(stdout, context.auth.backend!, workerStatus, configSnapshot.settings);

  const target: DoctorConfigLayer = options.project ? 'project' : 'user';
  const readline = createInterface({ input, output: promptOutput });
  let temporarySessionDir: string | undefined;
  let agent: Awaited<ReturnType<ConductorAgentFactory['create']>> | undefined;

  try {
    if (context.auth.backend === 'pi') {
      temporarySessionDir = await mkdtemp(
        join(tmpdir(), 'ensemble-doctor-pi-session-'),
      );
    }
    const customTools = createDoctorConfigTools({
      repoRoot,
      target,
      confirm: (proposal) =>
        confirmDoctorConfigWrite(readline, promptOutput, proposal),
    });
    const reasoning = resolveConductorReasoning(undefined, {
      config: context.config,
    });
    const agentOptions: ConductorAgentCreateOptions = {
      cwd: repoRoot,
      systemPrompt: DOCTOR_SYSTEM_PROMPT,
      ...(context.auth.modelId ? { modelId: context.auth.modelId } : {}),
      ...(reasoning ? { reasoning } : {}),
      builtinTools: false,
      ...(context.auth.backend === 'pi'
        ? {
            ...(context.auth.pi?.pi ? { pi: context.auth.pi.pi } : {}),
            piPromptResources: false,
            piSkills: false,
            piExtensions: false,
            piInternalExtensions: false,
            sessionDir: temporarySessionDir!,
          }
        : {}),
      customTools,
    };
    agent = await createAgentFactory(context.auth.backend!).create(agentOptions);

    const initial = await agent.send(
      `${DOCTOR_INITIAL_PROMPT}\n\n${formatInitialContext(
        context.auth.backend!,
        workerStatus,
        configSnapshot.settings,
      )}`,
    );
    writeAgentReply(stdout, initial.status, initial.result, initial.error?.message);

    for (;;) {
      const message = (await readline.question('\nDoctor> ')).trim();
      if (!message) continue;
      if (['exit', 'quit', 'done', '/exit'].includes(message.toLowerCase())) {
        break;
      }
      const response = await agent.send(message);
      writeAgentReply(
        stdout,
        response.status,
        response.result,
        response.error?.message,
      );
    }
  } finally {
    readline.close();
    try {
      await agent?.close();
    } finally {
      if (temporarySessionDir) {
        await rm(temporarySessionDir, { recursive: true, force: true });
      }
    }
  }
}

interface WorkerPreflight {
  preset?: string;
  message: string;
  ready: boolean;
}

function resolveWorkerPreflight(
  context: ResolvedConductorCommandContext,
  resolveSpawn: typeof resolveWorkerAcpSpawn,
  validateSpawn: typeof validateAcpPresetPrerequisites,
): WorkerPreflight {
  try {
    const spawn: ResolvedAcpSpawn = resolveSpawn({
      defaultOptions: { config: context.config },
    });
    validateSpawn(spawn);
    return {
      preset: spawn.preset,
      message: `preset ${spawn.preset}: 必要な adapter / CLI を確認しました。`,
      ready: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Invalid ENSEMBLE_DEFAULT_ACP_CLI')) {
      return {
        message:
          'ENSEMBLE_DEFAULT_ACP_CLI が未対応の値です。許可値は cursor / claude / codex / pi です（値は表示しません）。',
        ready: false,
      };
    }
    return {
      message: escapeTerminalControlCharacters(message),
      ready: false,
    };
  }
}

function writeInitialReport(
  stdout: Writable,
  backend: 'cursor' | 'pi',
  worker: WorkerPreflight,
  settings: DoctorConfigSettingSnapshot[],
): void {
  stdout.write('Conductor\n');
  stdout.write(`  認証設定: あり（backend: ${backend}）\n`);
  stdout.write('Worker spawn 前提\n');
  stdout.write(`  ${worker.message}\n`);
  stdout.write('Configuration\n');
  for (const { key, value, source } of settings) {
    stdout.write(`  ${key}: ${value}（適用元: ${source}）\n`);
  }
}

function formatInitialContext(
  backend: 'cursor' | 'pi',
  worker: WorkerPreflight,
  settings: DoctorConfigSettingSnapshot[],
): string {
  const settingLines = settings
    .map(({ key, value, source }) => `- ${key}: ${value} (source: ${source})`)
    .join('\n');
  return [
    `A conductor credential is configured for backend ${backend}; the first response may still detect an authentication problem.`,
    `Worker spawn preflight: ${worker.message}`,
    'Effective allowlisted config settings:',
    settingLines,
  ].join('\n');
}

async function confirmDoctorConfigWrite(
  readline: ReturnType<typeof createInterface>,
  promptOutput: Writable,
  proposal: DoctorConfigWriteProposal,
): Promise<boolean> {
  promptOutput.write('\n設定変更の提案\n');
  promptOutput.write(
    `  ${proposal.key}: ${proposal.current.value}（適用元: ${proposal.current.source}） → ${proposal.value}\n`,
  );
  promptOutput.write(
    `  保存先: ${proposal.target} config (${escapeTerminalControlCharacters(proposal.path)})\n`,
  );
  if (
    proposal.current.source === 'environment' ||
    (proposal.target === 'user' && proposal.current.source === 'project')
  ) {
    promptOutput.write(
      '  注意: 上位の environment / project 設定が優先されるため、この repository での実効値は変わらない場合があります。\n',
    );
  }
  const answer = await readline.question('この変更を保存しますか？ [y/N] ');
  return answer.trim().toLowerCase() === 'y';
}

function writeAgentReply(
  stdout: Writable,
  status: string,
  result: string | undefined,
  errorMessage: string | undefined,
): void {
  if (status === 'error') {
    if (isConductorAuthError(errorMessage ?? '')) {
      throw new Error(
        'Conductor 認証で接続できませんでした。`ensemble auth status` で確認し、`ensemble setup` または `ensemble auth login` で認証してください。秘密値を doctor に入力しないでください。',
      );
    }
    throw new Error(
      `Doctor agent を続行できませんでした: ${escapeTerminalControlCharacters(errorMessage ?? 'unknown error')}`,
    );
  }
  if (result?.trim()) {
    stdout.write(`\n${escapeTerminalControlCharacters(result.trim())}\n`);
  }
}
