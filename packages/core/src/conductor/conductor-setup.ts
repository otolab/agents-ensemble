import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';
import { ENSEMBLE_CONFIG_FILE } from '../config/load-ensemble-config.js';
import { parseEnsembleConfig } from '../config/parse-config.js';
import type { ConductorBackend } from '../config/types.js';
import {
  getProjectWriteBoundaryPaths,
  isPathWithinAnyRoot,
} from './conductor-path-safety.js';
import { resolvePiResourceRoots } from './pi-resource-loader.js';
import { withPiUserRootLock } from './pi-user-root-lock.js';

export interface WriteConductorSetupOptions {
  repoRoot: string;
  backend: ConductorBackend;
  pi?: {
    provider: string;
    modelId: string;
  };
  userEnsembleRoot?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Effective project Pi root; setup also protects the project .ensemble directory. */
  readonlyProjectPiDir?: string;
}

export interface ConductorSetupFiles {
  configPath: string;
  backend: ConductorBackend;
  pi?: {
    agentDir: string;
    settingsPath: string;
    provider: string;
    modelId: string;
  };
}

/**
 * Merge conductor setup into user config and Pi user settings.
 * Project config and project Pi resources are deliberately left untouched.
 */
export async function writeConductorSetupFiles(
  options: WriteConductorSetupOptions,
): Promise<ConductorSetupFiles> {
  const pi =
    options.backend === 'pi'
      ? {
          provider: options.pi?.provider.trim() ?? '',
          modelId: options.pi?.modelId.trim() ?? '',
        }
      : undefined;
  if (options.backend === 'pi' && (!pi?.provider || !pi.modelId)) {
    throw new Error('Pi setup requires a provider and model ID.');
  }

  const repoRoot = resolve(options.repoRoot);
  const userRoot = resolveUserEnsembleRoot({
    userEnsembleRoot: options.userEnsembleRoot,
    home: options.home,
  });
  const configPath = join(userRoot, ENSEMBLE_CONFIG_FILE);
  const defaultProjectPiDir = resolvePiResourceRoots({
    cwd: repoRoot,
    ...(options.env ? { env: options.env } : {}),
    ...(options.home ? { home: options.home } : {}),
  }).projectDir;
  const initialProjectPiDirs = [
    defaultProjectPiDir,
    ...(options.readonlyProjectPiDir ? [options.readonlyProjectPiDir] : []),
  ];
  const assertConfigPathSafe = async (projectPiDirs: readonly string[]) => {
    const boundaries = await getProjectWriteBoundaryPaths(repoRoot, projectPiDirs);
    if (await isPathWithinAnyRoot(configPath, [repoRoot, ...boundaries])) {
      throw new Error(
        'User config resolves inside the project repository or aliases a project-owned symlink target; setup did not write project config.',
      );
    }
  };
  const assertPiSettingsPathSafe = async (
    settingsPath: string,
    projectPiDirs: readonly string[],
  ) => {
    const boundaries = await getProjectWriteBoundaryPaths(repoRoot, projectPiDirs);
    if (await isPathWithinAnyRoot(settingsPath, boundaries)) {
      throw new Error(
        'User Pi settings resolve inside the project resource root (.ensemble or configured Pi root) or alias a project-owned symlink target; setup did not write project resources.',
      );
    }
  };
  const assertPiAgentDirSafe = async (agentDir: string, projectPiDirs: readonly string[]) => {
    const boundaries = await getProjectWriteBoundaryPaths(repoRoot, projectPiDirs);
    if (await isPathWithinAnyRoot(agentDir, boundaries)) {
      throw new Error(
        'User Pi resource root resolves inside the project resource root (.ensemble or configured Pi root) or aliases a project-owned symlink target; setup did not write project resources.',
      );
    }
  };
  await assertConfigPathSafe(initialProjectPiDirs);

  const { document: configDocument, value: userConfigValue } =
    await readYamlDocument(configPath);
  const userConfig = parseEnsembleConfig(userConfigValue);
  const roots = resolvePiResourceRoots({
    cwd: repoRoot,
    pi: userConfig.conductor?.pi,
    ...(options.env ? { env: options.env } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
  const readonlyProjectPiDir = options.readonlyProjectPiDir ?? roots.projectDir;
  const projectPiDirs = [
    roots.projectDir,
    readonlyProjectPiDir,
  ];
  await assertConfigPathSafe(projectPiDirs);

  let piFiles: ConductorSetupFiles['pi'];
  if (pi) {
    await assertPiAgentDirSafe(roots.agentDir, projectPiDirs);
    const settingsPath = join(roots.agentDir, 'settings.json');
    await assertPiSettingsPathSafe(settingsPath, projectPiDirs);
    piFiles = {
      agentDir: roots.agentDir,
      settingsPath,
      provider: pi.provider,
      modelId: pi.modelId,
    };
  }

  configDocument.setIn(['conductor', 'backend'], options.backend);

  // Prepare both serialized values before touching either destination. Each
  // file is then replaced atomically with private permissions.
  const configContents = ensureTrailingNewline(configDocument.toString());

  if (piFiles) {
    const userPiFiles = piFiles;
    await assertPiAgentDirSafe(userPiFiles.agentDir, projectPiDirs);
    await mkdir(userPiFiles.agentDir, { recursive: true, mode: 0o700 });
    await withPiUserRootLock(
      userPiFiles.agentDir,
      repoRoot,
      projectPiDirs,
      async () => {
        await assertPiAgentDirSafe(userPiFiles.agentDir, projectPiDirs);
        await assertPiSettingsPathSafe(userPiFiles.settingsPath, projectPiDirs);
        const settingsDocument = await readJsonDocument(userPiFiles.settingsPath);
        settingsDocument.defaultProvider = userPiFiles.provider;
        settingsDocument.defaultModel = userPiFiles.modelId;
        const settingsContents = `${JSON.stringify(settingsDocument, null, 2)}\n`;
        await atomicWriteFile(userPiFiles.settingsPath, settingsContents, async () => {
          await assertPiAgentDirSafe(userPiFiles.agentDir, projectPiDirs);
          await assertPiSettingsPathSafe(userPiFiles.settingsPath, projectPiDirs);
        });
      },
    );
  }
  try {
    await atomicWriteFile(configPath, configContents, () =>
      assertConfigPathSafe(projectPiDirs),
    );
  } catch (error) {
    if (piFiles) {
      throw new Error(
        `Pi settings は ${piFiles.settingsPath} に保存しましたが、user config ${configPath} の保存処理が完了しませんでした。config の状態を確認し、書き込み権限を直してから \`ensemble setup\` を再実行してください。`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    configPath,
    backend: options.backend,
    ...(piFiles ? { pi: piFiles } : {}),
  };
}

async function readYamlDocument(
  path: string,
): Promise<{
  document: ReturnType<typeof parseDocument>;
  value: Record<string, unknown>;
}> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    raw = '';
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(raw);
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    if (!document.contents) {
      document.contents = document.createNode({});
    }
  } catch {
    throw new Error(`Could not parse user config ${path}; setup did not overwrite it.`);
  }

  if (!isMap(document.contents)) {
    throw new Error(`User config ${path} must be an object; setup did not overwrite it.`);
  }
  const conductor = document.get('conductor', true);
  if (conductor !== undefined && !isMap(conductor)) {
    throw new Error(
      `conductor in user config ${path} must be an object; setup did not overwrite it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = document.toJS();
  } catch {
    throw new Error(`Could not parse user config ${path}; setup did not overwrite it.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`User config ${path} must be an object; setup did not overwrite it.`);
  }

  try {
    parseEnsembleConfig(parsed);
    return { document, value: parsed };
  } catch (error) {
    throw new Error(
      `Could not read user config ${path}; setup did not overwrite it: ${errorMessage(error)}`,
    );
  }
}

async function readJsonDocument(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse Pi settings ${path}; setup did not overwrite it.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must be an object; setup did not overwrite it.`);
  }
  return parsed;
}

async function atomicWriteFile(
  path: string,
  contents: string,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  await beforeReplace?.();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const targetPath = await resolveWriteTarget(path);
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomUUID()}.tmp`,
  );
  let file:
    | Awaited<ReturnType<typeof open>>
    | undefined;

  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await beforeReplace?.();
    if ((await resolveWriteTarget(path)) !== targetPath) {
      throw new Error(
        `Write target ${path} changed while preparing setup; refusing to replace a different file.`,
      );
    }
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveWriteTarget(path: string): Promise<string> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return path;
    throw error;
  }
  return details.isSymbolicLink() ? realpath(path) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
