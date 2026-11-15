import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import {
  ENSEMBLE_CONFIG_FILE,
  loadEnsembleConfig,
} from './load-ensemble-config.js';
import { parseEnsembleConfig } from './parse-config.js';
import type { EnsembleConfig } from './types.js';
import {
  ENSEMBLE_DEFAULT_ACP_CLI_ENV,
  isBuiltinAcpPresetId,
  type BuiltinAcpPresetId,
} from '../acp/resolve-acp-spawn.js';
import {
  isPathWithinAnyRoot,
} from '../conductor/conductor-path-safety.js';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';

export const DOCTOR_CONFIG_SETTING_PATHS = {
  'acp.defaultPreset': ['acp', 'defaultPreset'],
  'session.worktree': ['session', 'worktree'],
  'session.lazyWorkers': ['session', 'lazyWorkers'],
  'github.auth.allowGhAuthTokenFallback': [
    'github',
    'auth',
    'allowGhAuthTokenFallback',
  ],
} as const;

export type DoctorConfigSettingKey =
  keyof typeof DOCTOR_CONFIG_SETTING_PATHS;

export type DoctorConfigSettingValues = {
  'acp.defaultPreset': BuiltinAcpPresetId;
  'session.worktree': 'isolated' | 'in_repo';
  'session.lazyWorkers': boolean;
  'github.auth.allowGhAuthTokenFallback': boolean;
};

export type DoctorConfigSettingValue =
  DoctorConfigSettingValues[DoctorConfigSettingKey];
export type DoctorConfigLayer = 'user' | 'project';
export type DoctorConfigSettingSource =
  | 'default'
  | 'user'
  | 'project'
  | 'environment';

export interface DoctorConfigSettingSnapshot {
  key: DoctorConfigSettingKey;
  value: DoctorConfigSettingValue;
  source: DoctorConfigSettingSource;
}

export interface DoctorConfigSnapshot {
  projectConfigEnabled: boolean;
  settings: DoctorConfigSettingSnapshot[];
}

export interface ReadDoctorConfigOptions {
  repoRoot: string;
  userEnsembleRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DoctorConfigWriteProposal {
  key: DoctorConfigSettingKey;
  current: DoctorConfigSettingSnapshot;
  value: DoctorConfigSettingValue;
  target: DoctorConfigLayer;
  path: string;
}

export interface WriteDoctorConfigOptions extends ReadDoctorConfigOptions {
  key: DoctorConfigSettingKey;
  value: DoctorConfigSettingValue;
  target: DoctorConfigLayer;
  confirm: (proposal: DoctorConfigWriteProposal) => Promise<boolean>;
}

export interface WriteDoctorConfigResult {
  written: boolean;
  key: DoctorConfigSettingKey;
  value: DoctorConfigSettingValue;
  target: DoctorConfigLayer;
  path: string;
}

type UnknownRecord = Record<string, unknown>;

const SETTING_KEYS = Object.keys(
  DOCTOR_CONFIG_SETTING_PATHS,
) as DoctorConfigSettingKey[];

/** Read effective values and origins for the small, secret-free doctor allowlist. */
export async function readDoctorConfigSettings(
  options: ReadDoctorConfigOptions,
): Promise<DoctorConfigSnapshot> {
  const repoRoot = resolve(options.repoRoot);
  const userRoot = resolveUserEnsembleRoot({
    userEnsembleRoot: options.userEnsembleRoot,
  });
  const userConfigPath = join(userRoot, ENSEMBLE_CONFIG_FILE);
  const projectConfigPath = join(
    repoRoot,
    '.ensemble',
    ENSEMBLE_CONFIG_FILE,
  );

  await assertReadableConfigPaths({
    userConfigPath,
    projectConfigPath,
  });

  let config: EnsembleConfig;
  try {
    config = await loadEnsembleConfig(repoRoot, {
      userEnsembleRoot: userRoot,
      writeStderr: () => {},
    });
  } catch {
    throw new Error(
      'Could not resolve Ensemble settings. Check the config syntax; doctor did not display any config values.',
    );
  }

  const userLayer = await readConfigLayer(userConfigPath);
  const projectLayer = config.config.loadProjectConfig
    ? await readConfigLayer(projectConfigPath)
    : {};
  const env = options.env ?? process.env;
  const envPresetValue = env[ENSEMBLE_DEFAULT_ACP_CLI_ENV]?.trim();
  let envPreset: BuiltinAcpPresetId | undefined;
  if (envPresetValue) {
    if (!isBuiltinAcpPresetId(envPresetValue)) {
      throw new Error(
        `${ENSEMBLE_DEFAULT_ACP_CLI_ENV} is not a supported worker preset. Allowed values: cursor, claude, codex, pi. Its value was not displayed.`,
      );
    }
    envPreset = envPresetValue;
  }

  const effectiveValues: Record<
    DoctorConfigSettingKey,
    DoctorConfigSettingValue
  > = {
    'acp.defaultPreset': envPreset
      ? envPreset
      : config.acp.defaultPreset,
    'session.worktree': config.session.worktree,
    'session.lazyWorkers': config.session.lazyWorkers,
    'github.auth.allowGhAuthTokenFallback':
      config.github.auth.allowGhAuthTokenFallback,
  };

  return {
    projectConfigEnabled: config.config.loadProjectConfig,
    settings: SETTING_KEYS.map((key) => ({
      key,
      value: effectiveValues[key],
      source: settingSource({
        key,
        envPreset,
        userLayer,
        projectLayer,
        projectConfigEnabled: config.config.loadProjectConfig,
      }),
    })),
  };
}

/**
 * Write one allowlisted setting. The caller must obtain explicit operator
 * consent through `confirm`; no arbitrary path or config key is accepted.
 */
export async function writeDoctorConfigSetting(
  options: WriteDoctorConfigOptions,
): Promise<WriteDoctorConfigResult> {
  assertAllowedSetting(options.key, options.value);
  if (options.target !== 'user' && options.target !== 'project') {
    throw new Error('Unsupported config target; no config was changed.');
  }
  const repoRoot = resolve(options.repoRoot);
  const userRoot = resolveUserEnsembleRoot({
    userEnsembleRoot: options.userEnsembleRoot,
  });
  const userConfigPath = join(userRoot, ENSEMBLE_CONFIG_FILE);
  const projectConfigPath = join(
    repoRoot,
    '.ensemble',
    ENSEMBLE_CONFIG_FILE,
  );
  const targetPath =
    options.target === 'user' ? userConfigPath : projectConfigPath;

  const snapshot = await readDoctorConfigSettings({
    repoRoot,
    userEnsembleRoot: userRoot,
    env: options.env,
  });
  const current = snapshot.settings.find((setting) => setting.key === options.key);
  if (!current) {
    throw new Error('The requested doctor setting is unavailable.');
  }

  if (options.target === 'project' && !snapshot.projectConfigEnabled) {
    throw new Error(
      'Project config is disabled by the user config; doctor did not write anything.',
    );
  }

  await assertWriteTargetSafe({
    repoRoot,
    target: options.target,
    path: targetPath,
  });
  const accepted = await options.confirm({
    key: options.key,
    current,
    value: options.value,
    target: options.target,
    path: targetPath,
  });
  if (!accepted) {
    return {
      written: false,
      key: options.key,
      value: options.value,
      target: options.target,
      path: targetPath,
    };
  }

  await assertWriteTargetSafe({
    repoRoot,
    target: options.target,
    path: targetPath,
  });
  const document = await readConfigDocument(targetPath);
  const configValue = toRecord(document.toJS());
  for (const segment of DOCTOR_CONFIG_SETTING_PATHS[options.key].slice(
    0,
    -1,
  )) {
    const existing = configValue[segment];
    if (existing !== undefined && !isRecord(existing)) {
      throw new Error(
        'The target config has an invalid parent section; doctor did not write anything.',
      );
    }
  }

  try {
    document.setIn(DOCTOR_CONFIG_SETTING_PATHS[options.key], options.value);
    const updatedValue = toRecord(document.toJS());
    // Validate the complete target layer before replacing the file.
    parseEnsembleConfig(updatedValue);
  } catch {
    throw new Error(
      'The target config could not be updated safely; doctor did not write anything.',
    );
  }

  await atomicWriteConfig(targetPath, document.toString(), async () => {
    await assertWriteTargetSafe({
      repoRoot,
      target: options.target,
      path: targetPath,
    });
  });

  return {
    written: true,
    key: options.key,
    value: options.value,
    target: options.target,
    path: targetPath,
  };
}

function settingSource(options: {
  key: DoctorConfigSettingKey;
  envPreset?: string;
  userLayer: UnknownRecord;
  projectLayer: UnknownRecord;
  projectConfigEnabled: boolean;
}): DoctorConfigSettingSource {
  if (options.key === 'acp.defaultPreset' && options.envPreset) {
    return 'environment';
  }
  if (
    options.projectConfigEnabled &&
    hasSetting(options.projectLayer, options.key)
  ) {
    return 'project';
  }
  if (hasSetting(options.userLayer, options.key)) {
    return 'user';
  }
  return 'default';
}

function hasSetting(layer: UnknownRecord, key: DoctorConfigSettingKey): boolean {
  let value: unknown = layer;
  for (const segment of DOCTOR_CONFIG_SETTING_PATHS[key]) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return false;
    value = value[segment];
  }
  switch (key) {
    case 'acp.defaultPreset':
      return typeof value === 'string' && isBuiltinAcpPresetId(value);
    case 'session.worktree':
      return value === 'isolated' || value === 'in_repo' || value === 'in-repo';
    case 'session.lazyWorkers':
    case 'github.auth.allowGhAuthTokenFallback':
      return typeof value === 'boolean';
  }
  return false;
}

async function readConfigLayer(path: string): Promise<UnknownRecord> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new Error('Could not read the configured Ensemble settings file.');
  }

  try {
    const document = parseDocument(raw);
    if (document.errors.length > 0) throw document.errors[0];
    return document.contents ? toRecord(document.toJS()) : {};
  } catch {
    throw new Error(
      'Could not parse the configured Ensemble settings file; values were not displayed.',
    );
  }
}

async function readConfigDocument(path: string) {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error('Could not read the selected config file.');
    }
  }

  try {
    const document = parseDocument(raw);
    if (document.errors.length > 0) throw document.errors[0];
    if (!document.contents) {
      document.contents = document.createNode({}) as NonNullable<
        typeof document.contents
      >;
    }
    if (!isMap(document.contents)) throw new Error('Expected a config map.');
    toRecord(document.toJS());
    return document;
  } catch {
    throw new Error(
      'Could not parse the selected config file; doctor did not overwrite it.',
    );
  }
}

async function assertReadableConfigPaths(options: {
  userConfigPath: string;
  projectConfigPath: string;
}): Promise<void> {
  const projectDirectory = dirname(options.projectConfigPath);
  const projectDirectoryDetails = await lstatOrMissing(projectDirectory);
  if (projectDirectoryDetails?.isSymbolicLink()) {
    throw new Error(
      'Project config is inside a symbolic-link directory; doctor will not inspect it.',
    );
  }
  for (const path of [options.userConfigPath, options.projectConfigPath]) {
    const details = await lstatOrMissing(path);
    if (details?.isSymbolicLink()) {
      throw new Error(
        'A config file is a symbolic link; doctor will not inspect it.',
      );
    }
  }
}

async function assertWriteTargetSafe(options: {
  repoRoot: string;
  target: DoctorConfigLayer;
  path: string;
}): Promise<void> {
  if (options.target === 'user') {
    if (
      await isPathWithinAnyRoot(options.path, [
        options.repoRoot,
        join(options.repoRoot, '.ensemble'),
      ])
    ) {
      throw new Error(
        'User config resolves inside the project; doctor did not write project config.',
      );
    }
    const details = await lstatOrMissing(options.path);
    if (details?.isSymbolicLink()) {
      throw new Error(
        'User config is a symbolic link; doctor did not replace it.',
      );
    }
    return;
  }

  const projectDirectory = dirname(options.path);
  const directoryDetails = await lstatOrMissing(projectDirectory);
  if (directoryDetails?.isSymbolicLink()) {
    throw new Error(
      'Project config directory is a symbolic link; doctor did not write anything.',
    );
  }
  if (directoryDetails && !directoryDetails.isDirectory()) {
    throw new Error(
      'Project config directory is not a directory; doctor did not write anything.',
    );
  }
  const fileDetails = await lstatOrMissing(options.path);
  if (fileDetails?.isSymbolicLink()) {
    throw new Error(
      'Project config is a symbolic link; doctor did not replace it.',
    );
  }
  if (fileDetails && !fileDetails.isFile()) {
    throw new Error(
      'Project config is not a regular file; doctor did not write anything.',
    );
  }
}

async function atomicWriteConfig(
  path: string,
  contents: string,
  beforeReplace: () => Promise<void>,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await beforeReplace();
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await beforeReplace();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error('Could not save the selected config; no other file was changed.');
  }
}

async function lstatOrMissing(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error('Could not verify the config path safely.');
  }
}

function assertAllowedSetting(
  key: string,
  value: unknown,
): asserts key is DoctorConfigSettingKey {
  const allowedValues: Record<DoctorConfigSettingKey, readonly unknown[]> = {
    'acp.defaultPreset': ['cursor', 'claude', 'codex', 'pi'],
    'session.worktree': ['isolated', 'in_repo'],
    'session.lazyWorkers': [true, false],
    'github.auth.allowGhAuthTokenFallback': [true, false],
  };
  if (
    !SETTING_KEYS.includes(key as DoctorConfigSettingKey) ||
    !allowedValues[key as DoctorConfigSettingKey].includes(value)
  ) {
    throw new Error(
      'Unsupported doctor config setting or value; no config was changed.',
    );
  }
}

function toRecord(value: unknown): UnknownRecord {
  if (!isRecord(value)) throw new Error('Expected a config mapping.');
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
