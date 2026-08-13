import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * profile の `workspace` を絶対パスへ解決する。
 * - 絶対パスはそのまま
 * - `./` / `../` で始まる相対パスは profile ディレクトリ基準
 * - それ以外の相対パスは repo-root（`loadProfile` の cwd）基準
 */
export function resolveWorkerWorkspacePath(
  workspace: string,
  profileDir: string,
  repoRoot: string,
): string {
  if (isAbsolute(workspace)) {
    return workspace;
  }
  if (workspace.startsWith('.')) {
    return resolve(profileDir, workspace);
  }
  return resolve(repoRoot, workspace);
}

/** worker ACP cwd が存在するディレクトリであることを検証する。 */
export function assertWorkerWorkspaceDirectory(
  path: string,
  workerName?: string,
): void {
  const label = workerName ? `Worker "${workerName}"` : 'Worker';
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      throw new Error(`${label} workspace is not a directory: ${path}`);
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new Error(`${label} workspace does not exist: ${path}`);
    }
    throw error;
  }
}

/** harness 表示用に workspace パスを要約する（repo-root 相対を優先）。 */
export function summarizeWorkspacePath(path: string, repoRoot: string): string {
  const normalizedRoot = resolve(repoRoot);
  const normalizedPath = resolve(path);
  if (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  ) {
    const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\//, '');
    return relative || '.';
  }
  return normalizedPath;
}
