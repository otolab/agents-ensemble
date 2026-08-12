/**
 * Integration / e2e 用 ACP テスト設定。
 * test-acp.yaml が無い場合は describe.skipIf でスキップする。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export function hasAcpTestConfig(): boolean {
  return loadAcpTestConfig() != null;
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
