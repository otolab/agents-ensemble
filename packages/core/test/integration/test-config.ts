/**
 * Integration / e2e 用 ACP テスト設定。
 * 設定ファイルか ACP agent command が使えない場合は理由つきで skip する。
 */
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { resolveConductorModelId } from '../../src/conductor/resolve-conductor-model-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'test-acp.yaml');

export interface AcpTestConfig {
  /** `agent` バイナリのパス。省略時は PATH から解決 */
  agentCommand?: string;
  agentArgs?: string[];
  /** integration: session を開く cwd */
  cwd?: string;
  /** e2e: テスト用 Issue URL */
  issueUrl?: string;
  /** e2e: worker Skill 名 */
  skillName?: string;
  /** e2e: 作業対象のローカル git clone */
  repoRoot?: string;
  /** conductor SDK の model id（省略時: auto） */
  conductorModelId?: string;
}

let _config: AcpTestConfig | undefined;
let _loaded = false;

export function loadAcpTestConfig(): AcpTestConfig | undefined {
  if (_loaded) return _config;
  _loaded = true;

  if (!existsSync(CONFIG_PATH)) {
    return undefined;
  }

  const content = readFileSync(CONFIG_PATH, 'utf-8');
  _config = yaml.load(content) as AcpTestConfig;
  return _config;
}

export function getAcpTestConfigSkipReason(
  config: AcpTestConfig | undefined,
  isCommandAvailable: (
    command: string,
    cwd: string,
  ) => boolean = isAcpAgentCommandAvailable,
): string | undefined {
  if (!config) {
    return 'test-acp.yaml is missing; copy test-acp.yaml.example and configure it.';
  }

  const command = config.agentCommand ?? 'agent';
  if (!isCommandAvailable(command, config.cwd ?? process.cwd())) {
    return `ACP agent command "${command}" is unavailable or not executable; install it or set agentCommand in test-acp.yaml.`;
  }

  return undefined;
}

export function isAcpAgentCommandAvailable(
  command: string,
  cwd = process.cwd(),
  pathValue = process.env.PATH,
): boolean {
  const hasPathSeparator = command.includes(sep) || command.includes('/');
  const candidates = hasPathSeparator || isAbsolute(command)
    ? [resolve(cwd, command)]
    : pathValue === undefined
      ? []
      : pathValue
          .split(delimiter)
          .map((directory) => resolve(directory || cwd, command));

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  return candidates.some((candidate) => {
    const hasKnownExtension = extensions.some(
      (extension) =>
        extension !== '' &&
        candidate.toLowerCase().endsWith(extension.toLowerCase()),
    );
    const candidatesWithExtensions = hasKnownExtension
      ? [candidate]
      : [
          candidate,
          ...extensions
            .filter(Boolean)
            .map((extension) => candidate + extension),
        ];

    return candidatesWithExtensions.some((executablePath) => {
      try {
        // accessSync(X_OK) checks both existence and executable permission on POSIX.
        if (!statSync(executablePath).isFile()) return false;
        if (process.platform !== 'win32') {
          accessSync(executablePath, constants.X_OK);
        }
        return true;
      } catch {
        return false;
      }
    });
  });
}

export function getAcpTestConfig(): AcpTestConfig {
  const config = loadAcpTestConfig();
  if (!config) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy test-acp.yaml.example and configure.`,
    );
  }
  return config;
}

/** conductor integration / e2e 用モデル ID。 */
export function getConductorModelId(): string {
  return resolveConductorModelId(loadAcpTestConfig()?.conductorModelId);
}

export const acpTestConfigSkipReason = getAcpTestConfigSkipReason(
  loadAcpTestConfig(),
);
