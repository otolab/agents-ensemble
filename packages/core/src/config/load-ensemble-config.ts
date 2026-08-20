import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { ENSEMBLE_DIR } from '../profile/profile-paths.js';
import { deepMerge } from './deep-merge.js';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import { parseEnsembleConfig } from './parse-config.js';
import type { EnsembleConfig } from './types.js';

export const ENSEMBLE_CONFIG_FILE = 'config.yaml';

export interface LoadEnsembleConfigOptions {
  /** テスト用。既定は `~/.ensemble`。 */
  userEnsembleRoot?: string;
}

function userConfigPath(options: LoadEnsembleConfigOptions): string {
  const root = options.userEnsembleRoot ?? join(homedir(), ENSEMBLE_DIR);
  return join(root, ENSEMBLE_CONFIG_FILE);
}

function projectConfigPath(repoRoot: string): string {
  return join(repoRoot, ENSEMBLE_DIR, ENSEMBLE_CONFIG_FILE);
}

async function readConfigYaml(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = await readFile(path, 'utf8');
  return yaml.load(raw);
}

function mergeConfigLayer(
  base: EnsembleConfig,
  layer: Partial<EnsembleConfig>,
): EnsembleConfig {
  return deepMerge(
    base as unknown as Record<string, unknown>,
    layer as unknown as Record<string, unknown>,
  ) as unknown as EnsembleConfig;
}

/**
 * user → project の順で deep merge し、コード内デフォルトをベースに解決する。
 * どちらのファイルも無い場合は {@link DEFAULT_ENSEMBLE_CONFIG} を返す。
 */
export async function loadEnsembleConfig(
  repoRoot: string,
  options: LoadEnsembleConfigOptions = {},
): Promise<EnsembleConfig> {
  let merged: EnsembleConfig = structuredClone(DEFAULT_ENSEMBLE_CONFIG);

  const userRaw = await readConfigYaml(userConfigPath(options));
  if (userRaw !== undefined) {
    merged = mergeConfigLayer(merged, parseEnsembleConfig(userRaw));
  }

  const projectRaw = await readConfigYaml(projectConfigPath(repoRoot));
  if (projectRaw !== undefined) {
    merged = mergeConfigLayer(merged, parseEnsembleConfig(projectRaw));
  }

  return merged;
}
