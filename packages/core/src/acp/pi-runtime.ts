import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type { ResolvedAcpSpawn } from './resolve-acp-spawn.js';

const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent';
const BUILTIN_PI_ACP_PACKAGE = 'pi-acp-builtin';
const BUILTIN_PI_ACP_VERSION = '0.0.34';
export const BUILTIN_PI_MIN_NODE_VERSION = '22.19.0';

export function isBuiltinPiNodeVersionSupported(
  version = process.versions.node,
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    version,
  );
  if (!match) return false;

  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [22, 19, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return match[4] === undefined;
}

export function assertBuiltinPiNodeVersionSupported(
  version = process.versions.node,
): void {
  if (!isBuiltinPiNodeVersionSupported(version)) {
    throw new Error(
      `[acp] builtin Pi runtime requires Node.js ${BUILTIN_PI_MIN_NODE_VERSION} or later (current: ${version}). Use the BYO Pi runtime or upgrade Node.js.`,
    );
  }
}

export function resolveBundledPiCliPath(
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const require = createRequire(fromModuleUrl);
  const packageJsonPath = require
    .resolve
    .paths(PI_CODING_AGENT_PACKAGE)
    ?.map((nodeModulesPath) =>
      join(
        nodeModulesPath,
        '@earendil-works',
        'pi-coding-agent',
        'package.json',
      ),
    )
    .find(existsSync);
  if (!packageJsonPath) {
    throw new Error(
      `[acp] builtin Pi runtime could not resolve ${PI_CODING_AGENT_PACKAGE}. Reinstall @agents-ensemble/core with its dependencies.`,
    );
  }

  const packageDirectory = dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    bin?: unknown;
  };
  if (pkg.name !== PI_CODING_AGENT_PACKAGE) {
    throw new Error(
      `[acp] builtin Pi runtime resolved an unexpected package for ${PI_CODING_AGENT_PACKAGE}.`,
    );
  }

  const bin =
    typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin &&
          typeof pkg.bin === 'object' &&
          !Array.isArray(pkg.bin)
        ? (pkg.bin as Record<string, unknown>).pi
        : undefined;
  if (typeof bin !== 'string' || bin.trim() === '') {
    throw new Error(
      `[acp] ${PI_CODING_AGENT_PACKAGE} does not declare the \`pi\` CLI bin.`,
    );
  }
  const binPath = resolve(packageDirectory, bin);
  const relativeBinPath = relative(packageDirectory, binPath);
  if (
    relativeBinPath === '..' ||
    relativeBinPath.startsWith(`..${sep}`) ||
    !existsSync(binPath)
  ) {
    throw new Error(
      `[acp] ${PI_CODING_AGENT_PACKAGE} declares a missing or invalid \`pi\` CLI bin.`,
    );
  }
  return binPath;
}

/** Resolve the builtin-only alias to the pinned upstream pi-acp package. */
export function resolveBuiltinPiAcpEntrypointPath(
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const require = createRequire(fromModuleUrl);
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(
      `${BUILTIN_PI_ACP_PACKAGE}/package.json`,
    );
  } catch (error) {
    throw new Error(
      `[acp] builtin Pi runtime could not resolve upstream pi-acp@${BUILTIN_PI_ACP_VERSION} (${BUILTIN_PI_ACP_PACKAGE}). Reinstall @agents-ensemble/core with its dependencies.`,
      { cause: error },
    );
  }

  const packageDirectory = dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    bin?: unknown;
  };
  if (pkg.name !== 'pi-acp' || pkg.version !== BUILTIN_PI_ACP_VERSION) {
    throw new Error(
      `[acp] builtin Pi runtime expected upstream pi-acp@${BUILTIN_PI_ACP_VERSION}, but resolved an unexpected package.`,
    );
  }

  const bin =
    typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin &&
          typeof pkg.bin === 'object' &&
          !Array.isArray(pkg.bin)
        ? (pkg.bin as Record<string, unknown>)['pi-acp']
        : undefined;
  if (typeof bin !== 'string' || bin.trim() === '') {
    throw new Error(
      `[acp] upstream pi-acp@${BUILTIN_PI_ACP_VERSION} does not declare its \`pi-acp\` bin.`,
    );
  }

  const entrypoint = resolve(packageDirectory, bin);
  const relativeEntrypoint = relative(packageDirectory, entrypoint);
  if (
    relativeEntrypoint === '..' ||
    relativeEntrypoint.startsWith(`..${sep}`) ||
    !existsSync(entrypoint)
  ) {
    throw new Error(
      `[acp] upstream pi-acp@${BUILTIN_PI_ACP_VERSION} declares a missing or invalid \`pi-acp\` bin.`,
    );
  }
  return entrypoint;
}

/** Resolve the core-owned wrapper shipped beside the compiled ACP runtime. */
export function resolveBuiltinPiAcpWrapperPath(
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const packageDirectory = resolve(
    dirname(fileURLToPath(fromModuleUrl)),
    '..',
    '..',
  );
  return join(packageDirectory, 'dist', 'acp', 'pi-acp-wrapper.js');
}

/** Resolve the small launcher that restores the operator home for Pi and shell children. */
export function resolveBuiltinPiCliEnvWrapperPath(
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const packageDirectory = resolve(
    dirname(fileURLToPath(fromModuleUrl)),
    '..',
    '..',
  );
  const wrapperPath = join(
    packageDirectory,
    'assets',
    'pi',
    process.platform === 'win32'
      ? 'pi-cli-env-wrapper.cmd'
      : 'pi-cli-env-wrapper.sh',
  );
  if (!existsSync(wrapperPath)) {
    throw new Error(
      `[acp] builtin Pi runtime could not find its Pi CLI environment wrapper: ${wrapperPath}`,
    );
  }
  return wrapperPath;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== '');
}

function resolvePiCliHome(spawn: ResolvedAcpSpawn): {
  home: string;
  userProfile: string;
} {
  const configuredHome = firstNonEmpty(spawn.env?.HOME);
  const configuredUserProfile = firstNonEmpty(spawn.env?.USERPROFILE);
  const hostHome = firstNonEmpty(
    process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME,
    process.env.HOME,
    process.env.USERPROFILE,
    homedir(),
  )!;
  const hostUserProfile = firstNonEmpty(
    process.env.USERPROFILE,
    process.env.HOME,
    hostHome,
  )!;

  const home = configuredHome ?? configuredUserProfile ?? hostHome;
  const userProfile =
    configuredUserProfile ?? configuredHome ?? hostUserProfile ?? home;
  return { home, userProfile };
}

/**
 * Isolate upstream pi-acp's HOME-based map while preserving the operator's
 * home for the Pi CLI and its shell children. Internal paths override matching
 * acp.env values; explicit acp.env HOME / USERPROFILE become Pi CLI homes.
 */
export function configurePiWorkerRuntime(
  spawn: ResolvedAcpSpawn,
  input: {
    repoRoot: string;
    issueNumber: number;
    workerName: string;
    agentDir?: string;
  },
): ResolvedAcpSpawn {
  if (spawn.preset !== 'pi' || spawn.piRuntime !== 'builtin') return spawn;

  assertBuiltinPiNodeVersionSupported();
  const paths = resolveEnsemblePaths({ repoRoot: input.repoRoot });
  const workerHome = paths.piWorkerDir(input.workerName, input.issueNumber);
  const legacyWorkerHome = paths.legacyPiWorkerDir(input.workerName);
  const piCliHome = resolvePiCliHome(spawn);
  const env = { ...(spawn.env ?? {}) };
  // Upstream pi-acp has no map path override; HOME determines its map location.
  delete env.PI_ACP_SESSION_MAP_PATH;
  return {
    ...spawn,
    env: {
      ...env,
      ENSEMBLE_PI_BUILTIN_RUNTIME: '1',
      ENSEMBLE_PI_CLI_HOME: piCliHome.home,
      ENSEMBLE_PI_CLI_USERPROFILE: piCliHome.userProfile,
      ENSEMBLE_PI_CLI_NODE: process.execPath,
      ENSEMBLE_PI_CLI_EXECUTABLE: resolveBundledPiCliPath(),
      HOME: workerHome,
      USERPROFILE: workerHome,
      ENSEMBLE_PI_LEGACY_WORKER_HOME: legacyWorkerHome,
      PI_CODING_AGENT_DIR: input.agentDir ?? paths.piUserDir,
      PI_CODING_AGENT_SESSION_DIR: paths.piWorkerSessionsDir(
        input.workerName,
        input.issueNumber,
      ),
      PI_ACP_PI_COMMAND: resolveBuiltinPiCliEnvWrapperPath(),
    },
  };
}
