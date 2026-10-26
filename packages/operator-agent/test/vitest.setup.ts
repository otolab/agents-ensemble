import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import {
  createTestDirectories,
  environmentFailure,
  withProbeCleanup,
} from './setup-diagnostics.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, '../..');
const scratchRoot = join(repositoryRoot, '.tmp', 'operator-agent-vitest');
const userRoot = join(scratchRoot, `user-${process.pid}`);
const platformTempDirectory = tmpdir();

async function verifyWorkspaceScratch(): Promise<void> {
  const probePrefix = join(scratchRoot, 'oa-fs-');
  let probeDirectory: string;
  try {
    probeDirectory = await mkdtemp(probePrefix);
  } catch (error) {
    throw environmentFailure(
      'workspace scratch filesystem',
      error,
      probePrefix,
      platformTempDirectory,
      userRoot,
    );
  }

  const probePath = join(probeDirectory, 'probe');
  await withProbeCleanup(
    async () => {
      try {
        await writeFile(probePath, '');
      } catch (error) {
        throw environmentFailure(
          'workspace scratch filesystem',
          error,
          probePath,
          platformTempDirectory,
          userRoot,
        );
      }
    },
    () => rm(probeDirectory, { recursive: true, force: true }),
    (error) =>
      environmentFailure(
        'workspace scratch filesystem',
        error,
        probeDirectory,
        platformTempDirectory,
        userRoot,
      ),
  );
}

async function verifyUnixDomainSockets(): Promise<void> {
  const probePrefix = join(tmpdir(), 'oa-uds-');
  let probeDirectory: string;
  let server: net.Server | undefined;
  try {
    probeDirectory = await mkdtemp(probePrefix);
  } catch (error) {
    throw environmentFailure(
      'platform temporary filesystem',
      error,
      probePrefix,
      platformTempDirectory,
      userRoot,
    );
  }

  const socketPath = join(probeDirectory, 's');
  await withProbeCleanup(
    async () => {
      try {
        server = net.createServer();
        const listening = once(server, 'listening');
        server.listen(socketPath);
        await listening;
        await new Promise<void>((resolveClose, rejectClose) => {
          server!.close((error) => (error ? rejectClose(error) : resolveClose()));
        });
      } catch (error) {
        throw environmentFailure(
          'Unix domain sockets',
          error,
          socketPath,
          platformTempDirectory,
          userRoot,
        );
      }
    },
    async () => {
      try {
        if (server?.listening) {
          await new Promise<void>((resolveClose) =>
            server!.close(() => resolveClose()),
          );
        }
      } finally {
        await rm(probeDirectory, { recursive: true, force: true });
      }
    },
    (error) =>
      environmentFailure(
        'platform temporary filesystem',
        error,
        probeDirectory,
        platformTempDirectory,
        userRoot,
      ),
  );
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
  await createTestDirectories(scratchRoot, userRoot, platformTempDirectory);
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
