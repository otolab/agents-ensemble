import { mkdir } from 'node:fs/promises';

export type EnvironmentFailureArea =
  | 'workspace scratch filesystem'
  | 'platform temporary filesystem'
  | 'Unix domain sockets';

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String(error.code);
  }
  return 'unknown error';
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function environmentFailure(
  area: EnvironmentFailureArea,
  error: unknown,
  targetPath: string,
  platformTempDirectory: string,
  userRoot: string,
): Error {
  return new Error(
    `operator-agent tests cannot use the ${area} at ${targetPath} ` +
      `(${failureCode(error)}): ${failureMessage(error)}. ` +
      `They require a writable repository .tmp/ directory and Unix domain socket support. ` +
      `The test setup uses the platform TMPDIR=${platformTempDirectory} and ` +
      `ENSEMBLE_USER_ROOT=${userRoot}; check filesystem permissions and sandbox/CI socket restrictions.`,
    { cause: error },
  );
}

export async function createTestDirectories(
  scratchRoot: string,
  userRoot: string,
  platformTempDirectory: string,
  createDirectory: (path: string) => Promise<unknown> = async (path) =>
    mkdir(path, { recursive: true }),
): Promise<void> {
  let targetPath = scratchRoot;
  try {
    await createDirectory(scratchRoot);
    targetPath = userRoot;
    await createDirectory(userRoot);
  } catch (error) {
    throw environmentFailure(
      'workspace scratch filesystem',
      error,
      targetPath,
      platformTempDirectory,
      userRoot,
    );
  }
}

export async function withProbeCleanup<T>(
  probe: () => Promise<T>,
  cleanup: () => Promise<void>,
  diagnoseCleanupFailure: (error: unknown) => Error,
): Promise<T> {
  let probeFailed = false;
  try {
    return await probe();
  } catch (error) {
    probeFailed = true;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      if (!probeFailed) {
        throw diagnoseCleanupFailure(error);
      }
    }
  }
}
