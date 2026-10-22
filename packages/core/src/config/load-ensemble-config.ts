import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
  /** project config の解決状況を出力する。既定は stderr。 */
  writeStderr?: (message: string) => void;
}

function userConfigPath(options: LoadEnsembleConfigOptions): string {
  const root = options.userEnsembleRoot ?? join(homedir(), ENSEMBLE_DIR);
  return join(root, ENSEMBLE_CONFIG_FILE);
}

function projectConfigPath(repoRoot: string): string {
  return resolve(repoRoot, ENSEMBLE_DIR, ENSEMBLE_CONFIG_FILE);
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
  const writeStderr =
    options.writeStderr ??
    ((message: string) => void process.stderr.write(`${message}\n`));
  let merged: EnsembleConfig = structuredClone(DEFAULT_ENSEMBLE_CONFIG);

  const userRaw = await readConfigYaml(userConfigPath(options));
  if (userRaw !== undefined) {
    merged = mergeConfigLayer(merged, parseEnsembleConfig(userRaw));
  }

  const projectPath = projectConfigPath(repoRoot);
  if (!merged.config.loadProjectConfig) {
    writeStderr('ensemble: project config をスキップしました（user 設定）');
  } else {
    const projectRaw = await readConfigYaml(projectPath);
    if (projectRaw !== undefined) {
      const projectLayer = parseEnsembleConfig(projectRaw);
      // config.loadProjectConfig は user 層だけが決める。project YAML の
      // 同名キーは設定全体へも merge せず、user / default の値を保つ。
      delete projectLayer.config;
      merged = mergeConfigLayer(merged, projectLayer);
      writeStderr(`ensemble: project config を読み込みました: ${projectPath}`);
    }
  }

  return merged;
}
