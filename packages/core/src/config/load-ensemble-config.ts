import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { ENSEMBLE_DIR } from '../profile/profile-paths.js';
import { deepMerge } from './deep-merge.js';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import { parseEnsembleConfig } from './parse-config.js';
import type { EnsembleConfig, EnsembleConfigLayer } from './types.js';

export const ENSEMBLE_CONFIG_FILE = 'config.yaml';

export interface LoadEnsembleConfigOptions {
  /** テスト用。既定は `~/.ensemble`。 */
  userEnsembleRoot?: string;
  /** 起動時に明示する追加 config。既定の user/project config の上に merge する。 */
  configPath?: string;
}

function userConfigPath(options: LoadEnsembleConfigOptions): string {
  const root = options.userEnsembleRoot ?? join(homedir(), ENSEMBLE_DIR);
  return join(root, ENSEMBLE_CONFIG_FILE);
}

function projectConfigPath(repoRoot: string): string {
  return join(repoRoot, ENSEMBLE_DIR, ENSEMBLE_CONFIG_FILE);
}

function resolveConfigPath(path: string): string {
  const expanded =
    path === '~'
      ? homedir()
      : path.startsWith('~/')
        ? join(homedir(), path.slice(2))
        : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
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
  layer: EnsembleConfigLayer,
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

  if (options.configPath !== undefined) {
    const explicitPath = resolveConfigPath(options.configPath);
    const explicitRaw = await readConfigYaml(explicitPath);
    if (explicitRaw === undefined) {
      throw new Error(`Explicit ensemble config file not found: ${explicitPath}`);
    }
    merged = mergeConfigLayer(
      merged,
      parseEnsembleConfig(explicitRaw),
    );
  }

  return merged;
}
