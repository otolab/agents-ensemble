import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runGit } from './run-git.js';

export interface LinkedWorktreeGitPaths {
  gitDir?: string;
  commonDir?: string;
  index?: string;
  objects?: string;
  refs?: string;
  logsHead?: string;
}

export interface LinkedWorktreeGitDiagnostic {
  type: 'linked-worktree-git-sandbox';
  cwd: string;
  gitPaths: LinkedWorktreeGitPaths;
  pathsOutsideWorkerCwd: string[];
  resolutionErrors?: string[];
  error: string;
}

const GIT_PATH_COMMANDS = [
  ['gitDir', ['rev-parse', '--git-dir']],
  ['commonDir', ['rev-parse', '--git-common-dir']],
  ['index', ['rev-parse', '--git-path', 'index']],
  ['objects', ['rev-parse', '--git-path', 'objects']],
  ['refs', ['rev-parse', '--git-path', 'refs']],
  ['logsHead', ['rev-parse', '--git-path', 'logs/HEAD']],
] as const;

/**
 * Read-only diagnosis for a Git failure from a worker linked worktree.
 * This resolves paths for logging only; it never adds them to a sandbox.
 */
export async function diagnoseLinkedWorktreeGitFailure(input: {
  cwd: string;
  error: unknown;
}): Promise<LinkedWorktreeGitDiagnostic> {
  const cwd = await realpathSafe(input.cwd);
  const gitPaths: LinkedWorktreeGitPaths = {};
  const resolutionErrors: string[] = [];

  for (const [name, args] of GIT_PATH_COMMANDS) {
    try {
      const { stdout } = await runGit(args.slice(), cwd);
      const path = stdout.trim();
      if (path) {
        gitPaths[name] = normalizeGitPath(path, cwd);
      }
    } catch (error) {
      resolutionErrors.push(`${name}: ${errorMessage(error)}`);
    }
  }

  const pathsOutsideWorkerCwd = uniquePaths(
    Object.values(gitPaths).filter((path) => !isPathWithin(cwd, path)),
  );

  return {
    type: 'linked-worktree-git-sandbox',
    cwd,
    gitPaths,
    pathsOutsideWorkerCwd,
    ...(resolutionErrors.length > 0 ? { resolutionErrors } : {}),
    error: errorMessage(input.error),
  };
}

/** Detect a likely Git sandbox denial in one worker stderr line. */
export function isGitSandboxPermissionError(line: string): boolean {
  return (
    /(operation not permitted|permission denied|read-only file system)/i.test(line) &&
    /(\bgit\b|\.git(?:[/\\]|$)|index\.lock|lock file)/i.test(line)
  );
}

/** Stable JSON payload for `harness.warning` / structured log sinks. */
export function formatLinkedWorktreeGitDiagnostic(
  diagnostic: LinkedWorktreeGitDiagnostic,
): string {
  return JSON.stringify(diagnostic);
}

function normalizeGitPath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
