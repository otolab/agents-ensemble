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
import { isPathWithinAnyRoot } from './conductor-path-safety.js';
import { resolvePiResourceRoots } from './pi-resource-loader.js';

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
  const projectEnsembleDir = join(repoRoot, '.ensemble');
  if (await isPathWithinAnyRoot(configPath, [repoRoot, projectEnsembleDir])) {
    throw new Error(
      'User config resolves inside the project repository; setup did not write project config.',
    );
  }
  const { document: configDocument, value: userConfigValue } =
    await readYamlDocument(configPath);
  const userConfig = parseEnsembleConfig(userConfigValue);

  let piFiles: ConductorSetupFiles['pi'];
  let settingsDocument: Record<string, unknown> | undefined;
  if (pi) {
    const roots = resolvePiResourceRoots({
      cwd: repoRoot,
      pi: userConfig.conductor?.pi,
      ...(options.env ? { env: options.env } : {}),
      ...(options.home ? { home: options.home } : {}),
    });
    const readonlyProjectPiDir = options.readonlyProjectPiDir ?? roots.projectDir;
    const protectedProjectRoots = [
      projectEnsembleDir,
      roots.projectDir,
      readonlyProjectPiDir,
    ];
    if (await isPathWithinAnyRoot(roots.agentDir, protectedProjectRoots)) {
      throw new Error(
        'User Pi resource root resolves inside the project resource root (.ensemble or configured Pi root); setup did not write project resources.',
      );
    }
    const settingsPath = join(roots.agentDir, 'settings.json');
    if (await isPathWithinAnyRoot(settingsPath, protectedProjectRoots)) {
      throw new Error(
        'User Pi settings resolve inside the project resource root (.ensemble or configured Pi root); setup did not write project resources.',
      );
    }
    settingsDocument = await readJsonDocument(settingsPath);
    settingsDocument.defaultProvider = pi.provider;
    settingsDocument.defaultModel = pi.modelId;
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
  const settingsContents = settingsDocument
    ? `${JSON.stringify(settingsDocument, null, 2)}\n`
    : undefined;

  if (piFiles && settingsContents !== undefined) {
    await atomicWriteFile(piFiles.settingsPath, settingsContents);
  }
  try {
    await atomicWriteFile(configPath, configContents);
  } catch (error) {
    if (piFiles && settingsContents !== undefined) {
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

async function atomicWriteFile(path: string, contents: string): Promise<void> {
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
