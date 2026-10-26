import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { ENSEMBLE_DIR } from '../profile/profile-paths.js';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';
import { deepMerge } from './deep-merge.js';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import { parseEnsembleConfig } from './parse-config.js';
import type { EnsembleConfig, EnsembleConfigLayer } from './types.js';

export const ENSEMBLE_CONFIG_FILE = 'config.yaml';

export interface LoadEnsembleConfigOptions {
  /** テスト用。既定は `~/.ensemble`。 */
  userEnsembleRoot?: string;
  /** user config 層の代替ファイル。指定時は標準 user config を読まず、project 層は別途適用する。 */
  configPath?: string;
  /** project config の解決状況を出力する。既定は stderr。 */
  writeStderr?: (message: string) => void;
}

function userConfigPath(options: LoadEnsembleConfigOptions): string {
  const root = resolveUserEnsembleRoot({
    userEnsembleRoot: options.userEnsembleRoot,
  });
  return join(root, ENSEMBLE_CONFIG_FILE);
}

function projectConfigPath(repoRoot: string): string {
  return resolve(repoRoot, ENSEMBLE_DIR, ENSEMBLE_CONFIG_FILE);
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
 * 選択された user config → project config（読み込み有効時）の順で deep merge し、
 * コード内デフォルトをベースに解決する。`configPath` が指定された場合は
 * 標準 user config の代わりにそのファイルを user 層として読み、そこにある
 * `config.loadProjectConfig` の値で project 層の読み込みを制御する。
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

  const explicitPath =
    options.configPath !== undefined
      ? resolveConfigPath(options.configPath)
      : undefined;
  const selectedUserPath = explicitPath ?? userConfigPath(options);
  const userRaw = await readConfigYaml(selectedUserPath);
  if (explicitPath !== undefined && userRaw === undefined) {
    throw new Error(`Explicit ensemble config file not found: ${explicitPath}`);
  }
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
