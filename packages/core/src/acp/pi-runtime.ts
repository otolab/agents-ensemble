import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type { ResolvedAcpSpawn } from './resolve-acp-spawn.js';

const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent';
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

/**
 * Add per-worker user-layer storage and the bundled Pi CLI to a builtin Pi
 * spawn. Internal paths intentionally override matching values in acp.env.
 */
export function configurePiWorkerRuntime(
  spawn: ResolvedAcpSpawn,
  input: { repoRoot: string; workerName: string },
): ResolvedAcpSpawn {
  if (spawn.preset !== 'pi' || spawn.piRuntime !== 'builtin') return spawn;

  assertBuiltinPiNodeVersionSupported();
  const paths = resolveEnsemblePaths({ repoRoot: input.repoRoot });
  return {
    ...spawn,
    env: {
      ...(spawn.env ?? {}),
      ENSEMBLE_PI_BUILTIN_RUNTIME: '1',
      PI_CODING_AGENT_DIR: paths.piUserDir,
      PI_CODING_AGENT_SESSION_DIR: paths.piWorkerSessionsDir(
        input.workerName,
      ),
      PI_ACP_SESSION_MAP_PATH: paths.piWorkerSessionMapPath(input.workerName),
      PI_ACP_PI_COMMAND: resolveBundledPiCliPath(),
    },
  };
}
