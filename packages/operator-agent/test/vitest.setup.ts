import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, '../..');
const scratchRoot = join(repositoryRoot, '.tmp', 'operator-agent-vitest');
const userRoot = join(scratchRoot, `user-${process.pid}`);

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String(error.code);
  }
  return 'unknown error';
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwEnvironmentFailure(
  area:
    | 'workspace scratch filesystem'
    | 'platform temporary filesystem'
    | 'Unix domain sockets',
  error: unknown,
): never {
  throw new Error(
    `operator-agent tests cannot use the ${area} (${failureCode(error)}): ${failureMessage(error)}. ` +
      `They require a writable repository .tmp/ directory and Unix domain socket support. ` +
      `The test setup uses the platform TMPDIR=${tmpdir()} and ENSEMBLE_USER_ROOT=${userRoot}; ` +
      'check filesystem permissions and sandbox/CI socket restrictions.',
    { cause: error },
  );
}

async function verifyWorkspaceScratch(): Promise<void> {
  let probeDirectory: string | undefined;
  try {
    probeDirectory = await mkdtemp(join(scratchRoot, 'oa-fs-'));
    await writeFile(join(probeDirectory, 'probe'), '');
  } catch (error) {
    throwEnvironmentFailure('workspace scratch filesystem', error);
  } finally {
    if (probeDirectory) {
      await rm(probeDirectory, { recursive: true, force: true });
    }
  }
}

async function verifyUnixDomainSockets(): Promise<void> {
  let probeDirectory: string | undefined;
  let server: net.Server | undefined;
  try {
    probeDirectory = await mkdtemp(join(tmpdir(), 'oa-uds-'));
  } catch (error) {
    throwEnvironmentFailure('platform temporary filesystem', error);
  }

  try {
    const socketPath = join(probeDirectory, 's');
    server = net.createServer();
    const listening = once(server, 'listening');
    server.listen(socketPath);
    await listening;
    await new Promise<void>((resolveClose, rejectClose) => {
      server!.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  } catch (error) {
    throwEnvironmentFailure('Unix domain sockets', error);
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    if (probeDirectory) {
      await rm(probeDirectory, { recursive: true, force: true });
    }
  }
}

async function verifyCoreBuild(): Promise<void> {
  let coreRuntime: typeof import('@agents-ensemble/core/operator-runtime');
  try {
    coreRuntime = await import('@agents-ensemble/core/operator-runtime');
  } catch (error) {
    throw new Error(
      'operator-agent tests could not load @agents-ensemble/core/operator-runtime. ' +
        'Build the workspace core package first with `pnpm --filter @agents-ensemble/core build`.',
      { cause: error },
    );
  }

  if (typeof coreRuntime.resolveEnsemblePaths !== 'function') {
    throw new Error(
      'operator-agent tests loaded stale @agents-ensemble/core build output: ' +
        'resolveEnsemblePaths is unavailable. Rebuild core with ' +
        '`pnpm --filter @agents-ensemble/core build`.',
    );
  }

  const paths = coreRuntime.resolveEnsemblePaths({ repoRoot: repositoryRoot });
  if (paths.userRoot !== userRoot) {
    throw new Error(
      'operator-agent tests loaded stale @agents-ensemble/core build output: ' +
        `resolveEnsemblePaths returned ${paths.userRoot}, expected ${userRoot} from ENSEMBLE_USER_ROOT. ` +
        'Rebuild core with `pnpm --filter @agents-ensemble/core build`.',
    );
  }
}

try {
  await mkdir(scratchRoot, { recursive: true });
  await mkdir(userRoot, { recursive: true });
  process.env.ENSEMBLE_USER_ROOT = userRoot;

  await verifyCoreBuild();
  await verifyWorkspaceScratch();
  await verifyUnixDomainSockets();
} catch (error) {
  await rm(userRoot, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}

afterAll(async () => {
  await rm(userRoot, { recursive: true, force: true });
});
