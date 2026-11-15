import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createConductorAgentFactory,
  escapeTerminalControlCharacters,
  hasConductorAuth,
  isConductorAuthError,
  loadEnsembleConfig,
  readDoctorConfigSettings,
  resolveWorkerAcpSpawn,
  validateAcpPresetPrerequisites,
  type ConductorAgentCreateOptions,
  type ConductorAgentFactory,
  type ConductorAuthOptions,
  type DoctorConfigSnapshot,
  type EnsembleConfig,
} from '@agents-ensemble/core';
import type { Writable } from 'node:stream';
import { resolveConductorAuthContext } from './conductor-auth-command.js';
import { createDoctorReadConfigTool } from './doctor/doctor-config-tools.js';
import { DOCTOR_CHECK_SYSTEM_PROMPT } from './doctor/doctor-materials.js';

export type DoctorCheckMode = 'basic' | 'agent';
export type DoctorCheckStatus = 'ok' | 'fail' | 'skipped';

export interface DoctorCheck {
  id: 'conductor.auth' | 'worker.spawn' | 'config.read';
  status: DoctorCheckStatus;
  summary: string;
  action?: string;
  details?: {
    projectConfigEnabled: boolean;
    settings: DoctorConfigSnapshot['settings'];
  };
}

export interface DoctorCheckReport {
  schemaVersion: 1;
  mode: DoctorCheckMode;
  checks: DoctorCheck[];
  agent: {
    started: boolean;
    turns: number;
    answer: null;
    answerStatus: 'not_requested' | 'unavailable' | 'withheld';
  };
  nextActions: string[];
  error?: {
    code:
      | 'configuration_unavailable'
      | 'agent_failed'
      | 'backend_unsupported';
    message: string;
  };
  exitCode: 0 | 1 | 2;
}

export interface DoctorCheckContext {
  repoRoot: string;
  config: EnsembleConfig;
  auth: ConductorAuthOptions & { backend: 'cursor' | 'pi' };
}

export interface DoctorCheckCommandOptions {
  repoRoot?: string;
  request?: string | readonly string[];
  json?: boolean;
  stdout?: Writable;
  resolveContext?: (repoRoot: string) => Promise<DoctorCheckContext>;
  authCheck?: typeof hasConductorAuth;
  createAgentFactory?: (backend: 'cursor' | 'pi') => ConductorAgentFactory;
  readSettings?: typeof readDoctorConfigSettings;
  resolveWorkerSpawn?: typeof resolveWorkerAcpSpawn;
  validateWorkerSpawn?: typeof validateAcpPresetPrerequisites;
}

const AUTH_ACTIONS = [
  'ensemble auth status',
  'ensemble auth login',
  'ensemble setup',
];
const CONFIG_ACTION = '設定ファイルの構文と読み取り権限を確認してください。';
const WORKER_ACTION =
  '設定済み worker preset の adapter / CLI をインストールし、PATH を確認してください。';
const MAX_REQUEST_LENGTH = 4_000;

export async function runDoctorCheckCommand(
  options: DoctorCheckCommandOptions = {},
): Promise<DoctorCheckReport> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const request = normalizeRequest(options.request);
  const mode: DoctorCheckMode = request ? 'agent' : 'basic';
  const stdout = options.stdout ?? process.stdout;
  const report: DoctorCheckReport = {
    schemaVersion: 1,
    mode,
    checks: [],
    agent: {
      started: false,
      turns: 0,
      answer: null,
      answerStatus: request ? 'unavailable' : 'not_requested',
    },
    nextActions: [],
    exitCode: 0,
  };

  const readSettings = options.readSettings ?? readDoctorConfigSettings;
  const authCheck = options.authCheck ?? hasConductorAuth;
  const resolveWorkerSpawn = options.resolveWorkerSpawn ?? resolveWorkerAcpSpawn;
  const validateWorkerSpawn =
    options.validateWorkerSpawn ?? validateAcpPresetPrerequisites;

  let context: DoctorCheckContext | undefined;
  try {
    context = await (
      options.resolveContext ?? resolveDoctorCheckContext
    )(repoRoot);
  } catch {
    report.error = {
      code: 'configuration_unavailable',
      message: '設定を解決できませんでした。設定ファイルを確認してください。',
    };
    report.checks.push({
      id: 'conductor.auth',
      status: 'skipped',
      summary: 'backend を解決できないため、conductor 認証を確認できません。',
    });
    report.checks.push({
      id: 'worker.spawn',
      status: 'skipped',
      summary: '設定を解決できないため、worker 起動前提を確認できません。',
    });
  }

  let snapshot: DoctorConfigSnapshot | undefined;
  try {
    snapshot = await readSettings({ repoRoot });
    report.checks.push({
      id: 'config.read',
      status: 'ok',
      summary: '許可済みの非 secret 設定を読み取りました。',
      details: {
        projectConfigEnabled: snapshot.projectConfigEnabled,
        settings: snapshot.settings,
      },
    });
  } catch {
    if (!report.checks.some(({ id }) => id === 'config.read')) {
      report.checks.push({
        id: 'config.read',
        status: 'fail',
        summary: '許可済み設定を安全に読み取れませんでした。',
        action: CONFIG_ACTION,
      });
    }
    report.nextActions.push(CONFIG_ACTION);
  }

  let authReady = false;
  if (context) {
    try {
      authReady = authCheck(context.auth);
      report.checks.push({
        id: 'conductor.auth',
        status: authReady ? 'ok' : 'fail',
        summary: authReady
          ? `conductor 認証情報を確認しました（backend: ${context.auth.backend}）。`
          : `conductor 認証情報がありません（backend: ${context.auth.backend}）。`,
        ...(!authReady ? { action: AUTH_ACTIONS.join(' / ') } : {}),
      });
      if (!authReady) report.nextActions.push(...AUTH_ACTIONS);
    } catch {
      report.checks.push({
        id: 'conductor.auth',
        status: 'fail',
        summary: 'conductor 認証状態を確認できませんでした。',
        action: AUTH_ACTIONS.join(' / '),
      });
      report.nextActions.push(...AUTH_ACTIONS);
    }

    try {
      const spawn = resolveWorkerSpawn({
        defaultOptions: { config: context.config },
      });
      validateWorkerSpawn(spawn);
      report.checks.push({
        id: 'worker.spawn',
        status: 'ok',
        summary: 'worker adapter / CLI の spawn 前提を確認しました。',
      });
    } catch {
      report.checks.push({
        id: 'worker.spawn',
        status: 'fail',
        summary: 'worker adapter / CLI の spawn 前提を確認できませんでした。',
        action: WORKER_ACTION,
      });
      report.nextActions.push(WORKER_ACTION);
    }
  }

  if (request && context && authReady) {
    await runDiagnosticTurn({
      report,
      request,
      context,
      snapshot,
      createAgentFactory: options.createAgentFactory ?? createConductorAgentFactory,
    });
  }

  const checkOrder: DoctorCheck['id'][] = [
    'conductor.auth',
    'worker.spawn',
    'config.read',
  ];
  report.checks.sort(
    (left, right) => checkOrder.indexOf(left.id) - checkOrder.indexOf(right.id),
  );
  report.nextActions = [...new Set(report.nextActions)];
  report.exitCode =
    report.error
      ? 2
      : report.checks.some(({ status }) => status === 'fail')
        ? 1
        : 0;

  stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatDoctorCheckText(report)}\n`,
  );
  return report;
}

async function resolveDoctorCheckContext(
  repoRoot: string,
): Promise<DoctorCheckContext> {
  // Do not load a team profile: doctor check is independent of team/session
  // resolution and uses the same backend/auth rules from merged config only.
  const config = await loadEnsembleConfig(repoRoot, { writeStderr: () => {} });
  const auth = resolveConductorAuthContext({
    repoRoot,
    config,
  });
  return { repoRoot, config, auth };
}

async function runDiagnosticTurn(options: {
  report: DoctorCheckReport;
  request: string;
  context: DoctorCheckContext;
  snapshot?: DoctorConfigSnapshot;
  createAgentFactory: (backend: 'cursor' | 'pi') => ConductorAgentFactory;
}): Promise<void> {
  const { report, request, context } = options;
  const backend = context.auth.backend;
  if (backend === 'cursor') {
    report.error = {
      code: 'backend_unsupported',
      message:
        'Cursor backend では doctor 専用 system prompt を保証できないため、自然言語による agent 診断を実行できません。',
    };
    report.nextActions.push(
      'Pi backend に切り替えて再実行するか、request を省略して基本診断を実行してください。',
    );
    return;
  }
  if (backend !== 'pi') {
    report.error = {
      code: 'agent_failed',
      message: '診断 agent の backend を解決できませんでした。',
    };
    return;
  }

  let temporarySessionDir: string | undefined;
  let agent: Awaited<ReturnType<ConductorAgentFactory['create']>> | undefined;
  try {
    if (backend === 'pi') {
      temporarySessionDir = await mkdtemp(
        join(tmpdir(), 'ensemble-doctor-check-pi-session-'),
      );
    }

    const customTools = {
      doctor_read_config: createDoctorReadConfigTool({
        repoRoot: context.repoRoot,
      }),
    };
    const agentOptions: ConductorAgentCreateOptions = {
      cwd: context.repoRoot,
      systemPrompt: DOCTOR_CHECK_SYSTEM_PROMPT,
      ...(context.auth.modelId ? { modelId: context.auth.modelId } : {}),
      builtinTools: false,
      ...(backend === 'pi'
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

    agent = await options.createAgentFactory(backend).create(agentOptions);
    report.agent.started = true;
    report.agent.turns = 1;
    const result = await agent.send(formatDiagnosticRequest(request, report, options.snapshot));
    if (result.status !== 'finished') {
      const message = result.error?.message ?? '';
      if (isConductorAuthError(message)) {
        markAuthFailure(report);
        return;
      }
      report.error = {
        code: 'agent_failed',
        message: '診断 agent が応答を完了できませんでした。',
      };
      return;
    }
    report.agent.answerStatus = 'withheld';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (isConductorAuthError(message)) {
      markAuthFailure(report);
    } else {
      report.error = {
        code: 'agent_failed',
        message: '診断 agent を起動または実行できませんでした。',
      };
    }
  } finally {
    try {
      await agent?.close();
    } catch {
      if (!report.error) {
        report.error = {
          code: 'agent_failed',
          message: '診断 agent を安全に終了できませんでした。',
        };
      }
    }
    if (temporarySessionDir) {
      await rm(temporarySessionDir, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}

function formatDiagnosticRequest(
  request: string,
  report: DoctorCheckReport,
  snapshot?: DoctorConfigSnapshot,
): string {
  const checks = report.checks
    .map(({ id, status, summary }) => `- ${id}: ${status} — ${summary}`)
    .join('\n');
  const settings = snapshot
    ? snapshot.settings
        .map(({ key, value, source }) => `- ${key}: ${value} (source: ${source})`)
        .join('\n')
    : 'The allowlisted config could not be read.';
  return [
    'Operator request:',
    sanitizeDiagnosticRequest(request),
    '',
    'Harness checks:',
    checks || '- No checks are available.',
    '',
    'Allowlisted effective config:',
    settings,
  ].join('\n');
}

function markAuthFailure(report: DoctorCheckReport): void {
  const check = report.checks.find(({ id }) => id === 'conductor.auth');
  if (check) {
    check.status = 'fail';
    check.summary = 'conductor backend が認証を受け付けませんでした。';
    check.action = AUTH_ACTIONS.join(' / ');
  }
  report.nextActions.push(...AUTH_ACTIONS);
}

function normalizeRequest(
  request: string | readonly string[] | undefined,
): string | undefined {
  const joined =
    typeof request === 'string' ? request : request?.join(' ');
  const normalized = joined?.trim();
  return normalized || undefined;
}

function sanitizeDiagnosticRequest(value: string): string {
  const redacted = value
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/giu,
      '[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=?/giu, 'Bearer [redacted]')
    .replace(
      /\b(api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|auth[\s_-]*token|token|credential|password|secret)\s*(?::|=|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1: [redacted]',
    );
  const bounded =
    redacted.length > MAX_REQUEST_LENGTH
      ? `${redacted.slice(0, MAX_REQUEST_LENGTH)}\n[request truncated]`
      : redacted;
  return escapeTerminalControlCharacters(bounded, { preserveNewlines: true });
}

function formatDoctorCheckText(report: DoctorCheckReport): string {
  const lines = [
    `Doctor check (${report.mode})`,
    ...report.checks.map(
      ({ id, status, summary }) =>
        `[${status}] ${id}: ${escapeTerminalControlCharacters(summary)}`,
    ),
    `Agent: ${
      report.agent.started
        ? report.agent.answerStatus === 'withheld'
          ? `started (${report.agent.turns} turn; response withheld)`
          : `started (${report.agent.turns} turn; response unavailable)`
        : 'not started'
    }`,
  ];
  if (report.error) lines.push(`Error: ${report.error.message}`);
  if (report.nextActions.length > 0) {
    lines.push('', 'Next actions:', ...report.nextActions.map((action) => `- ${action}`));
  }
  return lines.join('\n');
}
