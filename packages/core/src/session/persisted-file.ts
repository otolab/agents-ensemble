import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

/** Copy a legacy file to its canonical location without replacing existing data. */
export async function copyFileIfMissing(
  sourcePath: string,
  destinationPath: string,
): Promise<boolean> {
  const directory = dirname(destinationPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, tempPath);
    await chmod(tempPath, 0o600);
    try {
      await link(tempPath, destinationPath);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    return true;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/** Create a canonical file atomically, without replacing a file created first. */
export async function writeFileIfMissing(
  destinationPath: string,
  contents: string,
): Promise<boolean> {
  const directory = dirname(destinationPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    try {
      await link(tempPath, destinationPath);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    return true;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}
