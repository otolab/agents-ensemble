import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  readdir,
  unlink,
  mkdir,
  open,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
  join,
} from 'node:path';
import {
  type ConductorJsonValue,
  type ConductorTool,
} from '@agents-ensemble/core/operator-runtime';

export const READ_OPERATOR_WORKSPACE_FILE_TOOL =
  'read_operator_workspace_file';
export const WRITE_OPERATOR_WORKSPACE_FILE_TOOL =
  'write_operator_workspace_file';
export const LIST_OPERATOR_WORKSPACE_FILES_TOOL = 'list_operator_workspace_files';
export const MOVE_OPERATOR_WORKSPACE_FILE_TOOL = 'move_operator_workspace_file';
export const DELETE_OPERATOR_WORKSPACE_FILE_TOOL = 'delete_operator_workspace_file';
export const MAX_OPERATOR_WORKSPACE_FILE_BYTES = 1024 * 1024;

const NOFOLLOW =
  typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

interface WorkspaceFilePath {
  absolutePath: string;
  relativePath: string;
  parts: string[];
}

/** Resolve the selected profile workspace once and reject a symlinked root. */
export async function resolveOperatorWorkspaceRoot(
  workspacePath: string,
): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(workspacePath);
  } catch {
    throw new Error('The active operator profile workspace is unavailable.');
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      'The active operator profile workspace must be a real directory, not a symbolic link.',
    );
  }
  return realpath(workspacePath);
}

/** Create file tools that are permanently scoped to the selected profile root. */
export function createOperatorWorkspaceFileTools(
  workspaceRoot: string,
): Record<string, ConductorTool> {
  const root = resolve(workspaceRoot);
  if (!isAbsolute(workspaceRoot) || root !== workspaceRoot) {
    throw new Error('The operator profile workspace root must be canonical and absolute.');
  }

  return {
    [LIST_OPERATOR_WORKSPACE_FILES_TOOL]: {
      name: LIST_OPERATOR_WORKSPACE_FILES_TOOL,
      description: 'List workspace entries without following symlinks during recursion. Path checks are not an OS sandbox and cannot prevent same-user TOCTOU changes.',
      inputSchema: {
        type: 'object', properties: {
          path: { type: 'string', description: 'Directory relative to workspace; omitted for root.' },
          recursive: { type: 'boolean' },
          maxDepth: { type: 'integer', minimum: 1, maximum: 10 },
          maxEntries: { type: 'integer', minimum: 1, maximum: 1000 },
        }, additionalProperties: false,
      },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['path', 'recursive', 'maxDepth', 'maxEntries']);
        if (args.recursive !== undefined && typeof args.recursive !== 'boolean') throw new Error('recursive must be a boolean.');
        const depth = boundedInteger(args.maxDepth, 3, 10, 'maxDepth');
        const limit = boundedInteger(args.maxEntries, 100, 1000, 'maxEntries');
        const requested = args.path === undefined || args.path === '.' ? undefined : resolveWorkspaceFilePath(root, args.path);
        try {
          const directory = requested ? await realpath(requested.absolutePath) : root;
          assertWithinWorkspace(root, directory);
          if (!(await stat(directory)).isDirectory()) throw new Error('The requested workspace path is not a directory.');
          const entries: ConductorJsonValue[] = [];
          let truncated = false;
          const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
            const names = (await readdir(dir)).sort();
            for (const name of names) {
              if (entries.length >= limit) { truncated = true; return; }
              const path = join(dir, name);
              const metadata = await lstat(path);
              const relativePath = prefix ? `${prefix}/${name}` : name;
              const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
              entries.push({ path: relativePath, type, size: metadata.size, mtime: metadata.mtime.toISOString() });
              if (args.recursive && type === 'directory' && level < depth) await walk(path, relativePath, level + 1);
              if (truncated) return;
            }
          };
          await walk(directory, requested?.relativePath ?? '', 1);
          return toolResult({ entries, truncated });
        } catch (error) { throw safeOperationError(error); }
      },
    },
    [MOVE_OPERATOR_WORKSPACE_FILE_TOOL]: {
      name: MOVE_OPERATOR_WORKSPACE_FILE_TOOL,
      description: 'Move a regular workspace file without overwriting. Directories and symlinks are rejected. Path checks are not an OS sandbox and cannot prevent same-user TOCTOU changes.',
      inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'], additionalProperties: false },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['source', 'destination']);
        const source = resolveWorkspaceFilePath(root, args.source);
        const destination = resolveWorkspaceFilePath(root, args.destination);
        try {
          const sourceParent = await existingWorkspaceParent(root, source.parts.slice(0, -1));
          const sourcePath = join(sourceParent, source.parts.at(-1)!);
          protectInstructions(root, sourcePath);
          const metadata = await lstat(sourcePath);
          if (!metadata.isFile()) throw new Error('The requested workspace path is not a regular file.');
          const destinationParent = await ensureWorkspaceParent(root, destination.parts.slice(0, -1));
          const destinationPath = join(destinationParent, destination.parts.at(-1)!);
          protectInstructions(root, destinationPath);
          try { await link(sourcePath, destinationPath); } catch (error) {
            if (isNodeError(error, 'EEXIST')) throw new Error('The destination already exists.');
            throw error;
          }
          try { await unlink(sourcePath); } catch (error) {
            try { await unlink(destinationPath); } catch { /* best-effort rollback */ }
            throw error;
          }
          return toolResult({ source: source.relativePath, destination: destination.relativePath });
        } catch (error) { throw safeOperationError(error); }
      },
    },
    [DELETE_OPERATOR_WORKSPACE_FILE_TOOL]: {
      name: DELETE_OPERATOR_WORKSPACE_FILE_TOOL,
      description: 'Delete a workspace file or the symlink itself; directories are rejected. Path checks are not an OS sandbox and cannot prevent same-user TOCTOU changes.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['path']);
        const requested = resolveWorkspaceFilePath(root, args.path);
        try {
          const parent = await existingWorkspaceParent(root, requested.parts.slice(0, -1));
          const target = join(parent, requested.parts.at(-1)!);
          protectInstructions(root, target);
          const metadata = await lstat(target);
          if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error('The requested workspace path is not a file or symlink.');
          await unlink(target);
          return toolResult({ path: requested.relativePath });
        } catch (error) { throw safeOperationError(error); }
      },
    },
    [READ_OPERATOR_WORKSPACE_FILE_TOOL]: {
      name: READ_OPERATOR_WORKSPACE_FILE_TOOL,
      description:
        'Read a UTF-8 file in the active operator profile workspace. The path must be relative to that workspace. During ordinary operation without concurrent directory changes, path checks reject absolute paths, parent traversal, and symlinks that resolve outside the workspace. These checks are not an OS sandbox and do not prevent same-user TOCTOU changes between validation and path-based open. Files larger than 1 MiB are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the active operator profile workspace.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['path']);
        const requested = resolveWorkspaceFilePath(root, args.path);
        const canonicalPath = await resolveExistingFile(root, requested);
        const handle = await open(canonicalPath, fsConstants.O_RDONLY | NOFOLLOW);
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) {
            throw new Error('The requested workspace path is not a file.');
          }
          if (metadata.size > MAX_OPERATOR_WORKSPACE_FILE_BYTES) {
            throw new Error(
              `Workspace files larger than ${MAX_OPERATOR_WORKSPACE_FILE_BYTES} bytes cannot be read.`,
            );
          }

          const buffer = Buffer.alloc(MAX_OPERATOR_WORKSPACE_FILE_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.byteLength) {
            const result = await handle.read(
              buffer,
              bytesRead,
              buffer.byteLength - bytesRead,
              bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
          if (bytesRead > MAX_OPERATOR_WORKSPACE_FILE_BYTES) {
            throw new Error(
              `Workspace files larger than ${MAX_OPERATOR_WORKSPACE_FILE_BYTES} bytes cannot be read.`,
            );
          }

          return toolResult({
            path: requested.relativePath,
            content: buffer.subarray(0, bytesRead).toString('utf8'),
          });
        } finally {
          await handle.close();
        }
      },
    },
    [WRITE_OPERATOR_WORKSPACE_FILE_TOOL]: {
      name: WRITE_OPERATOR_WORKSPACE_FILE_TOOL,
      description:
        'Create or replace a UTF-8 file in the active operator profile workspace. Parent directories are created inside that workspace as needed. The path must be relative. During ordinary operation without concurrent directory changes, path checks reject absolute paths, parent traversal, and symlinks that resolve outside the workspace. These checks are not an OS sandbox and do not prevent same-user TOCTOU changes between validation and path-based open. Content larger than 1 MiB is rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the active operator profile workspace.',
          },
          content: {
            type: 'string',
            description: 'UTF-8 text to write to the file.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['path', 'content']);
        const requested = resolveWorkspaceFilePath(root, args.path);
        if (typeof args.content !== 'string') {
          throw new Error('content must be a string.');
        }
        const byteLength = Buffer.byteLength(args.content, 'utf8');
        if (byteLength > MAX_OPERATOR_WORKSPACE_FILE_BYTES) {
          throw new Error(
            `Workspace files are limited to ${MAX_OPERATOR_WORKSPACE_FILE_BYTES} bytes.`,
          );
        }

        const parentPath = await ensureWorkspaceParent(
          root,
          requested.parts.slice(0, -1),
        );
        const targetPath = join(parentPath, requested.parts.at(-1)!);
        const canonicalTarget = await resolveOptionalTarget(root, targetPath);
        if (canonicalTarget) {
          const metadata = await stat(canonicalTarget);
          if (!metadata.isFile()) {
            throw new Error('The requested workspace path is not a file.');
          }
        }

        const handle = await open(
          canonicalTarget ?? targetPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_TRUNC |
            NOFOLLOW,
          0o600,
        );
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) {
            throw new Error('The requested workspace path is not a file.');
          }
          await handle.writeFile(args.content, 'utf8');
        } finally {
          await handle.close();
        }

        return toolResult({
          path: requested.relativePath,
          bytesWritten: byteLength,
        });
      },
    },
  };
}

function boundedInteger(value: ConductorJsonValue | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
  return value;
}

async function existingWorkspaceParent(root: string, parts: string[]): Promise<string> {
  const parent = await realpath(resolve(root, ...parts));
  assertWithinWorkspace(root, parent);
  if (!(await stat(parent)).isDirectory()) throw new Error('A workspace path component is not a directory.');
  return parent;
}

function protectInstructions(root: string, path: string): void {
  if (path === join(root, 'AGENTS.md')) throw new Error('The workspace AGENTS.md is protected from move and delete.');
}

function safeOperationError(error: unknown): Error {
  if (error instanceof Error && !('code' in error)) return error;
  return sanitizeFilesystemError(error);
}

function assertOnlyInputProperties(
  args: Record<string, ConductorJsonValue>,
  allowed: string[],
): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new Error('The workspace file tool received an unexpected argument.');
  }
}

function resolveWorkspaceFilePath(
  root: string,
  value: ConductorJsonValue | undefined,
): WorkspaceFilePath {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('path must be a non-empty workspace-relative file path.');
  }
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw outsideWorkspaceError();
  }
  if (value.includes('\\')) {
    throw new Error('Workspace file paths must use forward slashes.');
  }

  const parts = value
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.includes('..')) {
    throw outsideWorkspaceError();
  }
  if (parts.length === 0) {
    throw new Error('path must name a file inside the operator profile workspace.');
  }

  const absolutePath = resolve(root, ...parts);
  assertWithinWorkspace(root, absolutePath);
  return {
    absolutePath,
    relativePath: parts.join('/'),
    parts,
  };
}

async function resolveExistingFile(
  root: string,
  requested: WorkspaceFilePath,
): Promise<string> {
  const canonicalPath = await resolveOptionalTarget(root, requested.absolutePath);
  if (!canonicalPath) {
    throw new Error('The requested file does not exist inside the operator profile workspace.');
  }
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new Error('The requested workspace path is not a file.');
  }
  return canonicalPath;
}

async function resolveOptionalTarget(
  root: string,
  targetPath: string,
): Promise<string | undefined> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(targetPath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw sanitizeFilesystemError(error);

    // A dangling final symlink cannot be realpathed, but must not be replaced
    // or followed as a newly created path.
    let entry;
    try {
      entry = await lstat(targetPath);
    } catch (lstatError) {
      if (!isNodeError(lstatError, 'ENOENT')) throw sanitizeFilesystemError(lstatError);
    }
    if (entry?.isSymbolicLink()) throw outsideWorkspaceError();
    return undefined;
  }
  assertWithinWorkspace(root, canonicalPath);
  return canonicalPath;
}

async function ensureWorkspaceParent(
  root: string,
  parts: string[],
): Promise<string> {
  let current = root;
  for (const part of parts) {
    const candidate = join(current, part);
    try {
      await lstat(candidate);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw sanitizeFilesystemError(error);
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, 'EEXIST')) {
          throw sanitizeFilesystemError(mkdirError);
        }
      }
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate);
    } catch (error) {
      throw sanitizeFilesystemError(error);
    }
    assertWithinWorkspace(root, canonicalPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new Error('A workspace path component is not a directory.');
    }
    current = canonicalPath;
  }
  return current;
}

function assertWithinWorkspace(
  root: string,
  candidate: string,
): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw outsideWorkspaceError();
  }
}

function outsideWorkspaceError(): Error {
  return new Error(
    'The requested path is outside the active operator profile workspace. Use a relative path contained within that workspace.',
  );
}

function sanitizeFilesystemError(error: unknown): Error {
  if (isNodeError(error, 'ENOENT')) {
    return new Error('The requested file or directory does not exist in the workspace.');
  }
  if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
    return new Error('Permission was denied for the requested workspace file.');
  }
  if (isNodeError(error, 'ENOTDIR')) {
    return new Error('A workspace path component is not a directory.');
  }
  if (isNodeError(error, 'ELOOP')) {
    return outsideWorkspaceError();
  }
  return new Error('The workspace file operation failed.');
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function toolResult(
  value: Record<string, ConductorJsonValue>,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
