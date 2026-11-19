import { objectToolResult as toolResult } from './operator-utils.js';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { withOperatorWorkspaceLock } from './operator-workspace-lock.js';
import {
  lstat,
  cp,
  readFile,
  rename,
  rm,
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
  dirname,
  basename,
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
export const GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL = 'get_operator_workspace_move_status';
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
    throw new WorkspaceError('The active operator profile workspace is unavailable.');
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new WorkspaceError(
      'The active operator profile workspace must be a real directory, not a symbolic link.',
    );
  }
  return realpath(workspacePath);
}

/** Create file tools that are permanently scoped to the selected profile root. */
export function createOperatorWorkspaceFileTools(
  workspaceRoot: string,
  moveFs: MoveFilesystem = defaultMoveFilesystem,
): Record<string, ConductorTool> {
  const root = resolve(workspaceRoot);
  if (!isAbsolute(workspaceRoot) || root !== workspaceRoot) {
    throw new WorkspaceError('The operator profile workspace root must be canonical and absolute.');
  }

  const journalPath = workspaceMoveJournalPath(root);
  const tools: Record<string, ConductorTool> = {
    [LIST_OPERATOR_WORKSPACE_FILES_TOOL]: {
      name: LIST_OPERATOR_WORKSPACE_FILES_TOOL,
      description: 'List workspace entries without following symlinks during recursion. Recursive depth defaults to 3 (maximum 10); entries default to 100 (maximum 1000). Path checks are not an OS sandbox and cannot prevent same-user TOCTOU changes.',
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
        if (args.recursive !== undefined && typeof args.recursive !== 'boolean') throw new WorkspaceError('recursive must be a boolean.');
        const depth = boundedInteger(args.maxDepth, 3, 10, 'maxDepth');
        const limit = boundedInteger(args.maxEntries, 100, 1000, 'maxEntries');
        const requested = args.path === undefined || args.path === '.' ? undefined : resolveWorkspaceFilePath(root, args.path);
        try {
          const directory = requested ? await realpath(requested.absolutePath) : root;
          assertWithinWorkspace(root, directory);
          if (!(await stat(directory)).isDirectory()) throw new WorkspaceError('The requested workspace path is not a directory.');
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
      description: 'Move a workspace file or directory. Existing destinations require overwrite: true. Final symlinks, moving a directory into itself, and moving or replacing root AGENTS.md are rejected. The managed watch directory and its resolved parents cannot be moved. If a move fails or is interrupted, workspace file tools stop; use get_operator_workspace_move_status and tell the user to stop the agent and run ensemble operator-workspace-maintain --profile <name>. No automatic recovery or adoption is performed. Path checks are not an OS sandbox and cannot prevent same-user TOCTOU changes.',
      inputSchema: {
        type: 'object',
        properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' } },
        required: ['source', 'destination'], additionalProperties: false,
      },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['source', 'destination', 'overwrite']);
        if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new WorkspaceError('overwrite must be a boolean.');
        const source = resolveWorkspaceFilePath(root, args.source);
        const destination = resolveWorkspaceFilePath(root, args.destination);
        await protectWatch(root, source.absolutePath, true);
        await protectWatch(root, destination.absolutePath, true);
        try {
          const sourceParent = await existingWorkspaceParent(root, source.parts.slice(0, -1));
          const sourceEntry = join(sourceParent, source.parts.at(-1)!);
          protectInstructions(root, sourceEntry);
          const metadata = await lstat(sourceEntry);
          if (!metadata.isFile() && !metadata.isDirectory()) throw new WorkspaceError('The requested workspace path is not a regular file or directory.');
          const sourcePath = await realpath(sourceEntry);
          assertWithinWorkspace(root, sourcePath);
          await protectWatch(root, sourcePath, true);
          protectInstructions(root, sourcePath);
          const destinationParent = await ensureWorkspaceParent(root, destination.parts.slice(0, -1), metadata.isDirectory() ? sourcePath : undefined);
          const destinationPath = join(destinationParent, destination.parts.at(-1)!);
          await protectWatch(root, destinationPath, true);
          protectInstructions(root, destinationPath);
          try {
            const destinationEntry = await lstat(destinationPath);
            if (!destinationEntry.isSymbolicLink()) {
              const canonicalDestination = await realpath(destinationPath);
              await protectWatch(root, canonicalDestination, true);
              protectInstructions(root, canonicalDestination);
            }
          } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error; }
          if (sourcePath === destinationPath || (metadata.isDirectory() && isWithin(sourcePath, destinationPath))) {
            throw new WorkspaceError('A directory cannot be moved into itself, and source and destination must differ.');
          }
          if (isWithin(destinationPath, sourcePath)) throw new WorkspaceError('The destination cannot contain the source.');
          await moveWorkspaceEntry(root, sourcePath, destinationPath, args.overwrite === true, moveFs, journalPath);
          return toolResult({ source: source.relativePath, destination: destination.relativePath });
        } catch (error) { throw safeOperationError(error); }
      },
    },
    [DELETE_OPERATOR_WORKSPACE_FILE_TOOL]: {
      name: DELETE_OPERATOR_WORKSPACE_FILE_TOOL,
      description: 'Delete a workspace file or the symlink itself; directories, root AGENTS.md, and the managed watch directory and its contents are protected. Path checks are not an OS sandbox and cannot prevent same-user TOCTOU changes.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      execute: async (args) => {
        assertOnlyInputProperties(args, ['path']);
        const requested = resolveWorkspaceFilePath(root, args.path);
        await protectWatch(root, requested.absolutePath, true);
        try {
          const parent = await existingWorkspaceParent(root, requested.parts.slice(0, -1));
          const target = join(parent, requested.parts.at(-1)!);
          await protectWatch(root, target, true);
          protectInstructions(root, target);
          const metadata = await lstat(target);
          if (!metadata.isSymbolicLink()) protectInstructions(root, await realpath(target));
          if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new WorkspaceError('The requested workspace path is not a file or symlink.');
          await unlink(target);
          return toolResult({ path: requested.relativePath });
        } catch (error) { throw safeOperationError(error); }
      },
    },
    [READ_OPERATOR_WORKSPACE_FILE_TOOL]: {
      name: READ_OPERATOR_WORKSPACE_FILE_TOOL,
      description:
        'Read a UTF-8 file in the active operator profile workspace. The path must be relative to that workspace. During ordinary operation without concurrent directory changes, path checks reject absolute paths, parent traversal, and symlinks that resolve outside the workspace. These checks are not an OS sandbox and do not prevent same-user TOCTOU changes between validation and path-based open. Files larger than 1 MiB are rejected. File content is passed to the backend as is, without secret redaction; do not read files that may contain secrets.',
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
            throw new WorkspaceError('The requested workspace path is not a file.');
          }
          if (metadata.size > MAX_OPERATOR_WORKSPACE_FILE_BYTES) {
            throw new WorkspaceError(
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
            throw new WorkspaceError(
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
        'Create or replace a UTF-8 file in the active operator profile workspace. Parent directories are created inside that workspace as needed. The path must be relative. AGENTS.md can be edited, but the managed watch directory and its contents cannot be modified. During ordinary operation without concurrent directory changes, path checks reject absolute paths, parent traversal, and symlinks that resolve outside the workspace. These checks are not an OS sandbox and do not prevent same-user TOCTOU changes between validation and path-based open. Content larger than 1 MiB is rejected. Content is written as is, without secret redaction; do not store secrets.',
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
        await protectWatch(root, requested.absolutePath);
        if (typeof args.content !== 'string') {
          throw new WorkspaceError('content must be a string.');
        }
        const byteLength = Buffer.byteLength(args.content, 'utf8');
        if (byteLength > MAX_OPERATOR_WORKSPACE_FILE_BYTES) {
          throw new WorkspaceError(
            `Workspace files are limited to ${MAX_OPERATOR_WORKSPACE_FILE_BYTES} bytes.`,
          );
        }

        const parentPath = await ensureWorkspaceParent(
          root,
          requested.parts.slice(0, -1),
        );
        const targetPath = join(parentPath, requested.parts.at(-1)!);
        await protectWatch(root, targetPath);
        const canonicalTarget = await resolveOptionalTarget(root, targetPath);
        if (canonicalTarget) {
          await protectWatch(root, canonicalTarget);
          const metadata = await stat(canonicalTarget);
          if (!metadata.isFile()) {
            throw new WorkspaceError('The requested workspace path is not a file.');
          }
        }

        const handle = await open(
          canonicalTarget ?? targetPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            NOFOLLOW,
          0o600,
        );
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile()) {
            throw new WorkspaceError('The requested workspace path is not a file.');
          }
          await handle.truncate(0);
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

  // Calls within the singleton instance share a queue, including journal checks.
  let queue: Promise<unknown> = Promise.resolve();
  for (const tool of Object.values(tools)) {
    const execute = tool.execute;
    tool.execute = (args) => {
      const run = queue.then(() => withOperatorWorkspaceLock(root, async () => {
        await assertNoMoveJournal(journalPath);
        return execute(args);
      }));
      queue = run.catch(() => undefined);
      return run;
    };
  }
  tools[GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL] = {
    name: GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL,
    description: 'Inspect a pending workspace move when workspace file tools are blocked. Tell the user to stop all agents and run ensemble operator-workspace-maintain --profile <name>. Keep that command running while inspecting and preserving source, destination, staging and the journal; confirm completion in the command. Never remove the journal directly. A corrupt journal also requires manual inspection. No data is restored, selected, or deleted.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: (args) => {
      const run = queue.then(() => withOperatorWorkspaceLock(root, async () => {
        assertOnlyInputProperties(args, []);
        return toolResult(await readMoveStatus(root, journalPath));
      }));
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return tools;
}

type MoveFilesystem = Pick<typeof import('node:fs/promises'), 'rename' | 'cp' | 'rm'> & {
  checkpoint?: (stage: string) => Promise<void>;
};
const defaultMoveFilesystem: MoveFilesystem = { rename, cp, rm };

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function workspaceMoveJournalPath(root: string): string {
  const id = createHash('sha256').update(root).digest('hex');
  return join(dirname(root), `.ensemble-workspace-move-${id}.json`);
}

export async function assertNoMoveJournal(path: string): Promise<void> {
  try { await lstat(path); } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new WorkspaceError('Cannot check workspace move status. Inspect the move journal manually.');
  }
  throw new WorkspaceError('A workspace move needs manual inspection. Run ensemble operator-workspace-maintain --profile <name>.');
}

export async function readMoveStatus(root: string, journalPath: string): Promise<Record<string, ConductorJsonValue>> {
  try {
    const metadata = await lstat(journalPath);
    if (!metadata.isFile() || metadata.size > 16384) throw new Error();
    const data: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const record = data as Record<string, unknown>;
    if (record.version !== 1 || record.workspace !== root || typeof record.source !== 'string' || typeof record.destination !== 'string' || typeof record.staging !== 'string' || typeof record.overwrite !== 'boolean') throw new Error();
    for (const path of [record.source, record.destination, record.staging]) resolveWorkspaceFilePath(root, path as string);
    return { status: 'inspection_required', journal: basename(journalPath), source: record.source as string, destination: record.destination as string, staging: record.staging as string, overwrite: record.overwrite as boolean, guidance: 'Stop all operator agents and run ensemble operator-workspace-maintain --profile <name>. Keep it running while inspecting and preserving source, destination, staging/backup and staging/copy. Data may be partial. Confirm completion in the command; do not remove the journal directly.' };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { status: 'idle' };
    return { status: 'journal_unreadable', journal: basename(journalPath), guidance: 'Stop all operator agents and run ensemble operator-workspace-maintain --profile <name>. Keep it running while inspecting and preserving the journal and staging manually; confirm completion in the command. Do not remove the journal directly.' };
  }
}

/** Journal before changing data; on any failure retain every remaining entry for manual inspection. */
async function moveWorkspaceEntry(root: string, source: string, destination: string, overwrite: boolean, fs: MoveFilesystem, journalPath: string): Promise<void> {
  let exists = false;
  try { await lstat(destination); exists = true; } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  if (exists && !overwrite) throw new WorkspaceError('The destination already exists.');
  if (exists && (await lstat(destination)).isSymbolicLink()) throw new WorkspaceError('The destination cannot be a symbolic link.');

  const staging = join(dirname(destination), `.ensemble-move-${randomUUID()}`);
  const backup = join(staging, 'backup');
  const copy = join(staging, 'copy');
  const pathInWorkspace = (path: string) => relative(root, path).split(sep).join('/');
  const record = JSON.stringify({ version: 1, workspace: root, source: pathInWorkspace(source), destination: pathInWorkspace(destination), staging: pathInWorkspace(staging), overwrite });
  const handle = await open(journalPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    await fs.checkpoint?.('journal_open');
    if (fs.checkpoint) {
      const middle = Math.floor(record.length / 2);
      await handle.writeFile(record.slice(0, middle), 'utf8');
      await fs.checkpoint('journal_partial');
      await handle.writeFile(record.slice(middle), 'utf8');
    } else {
      await handle.writeFile(record, 'utf8');
    }
    await fs.checkpoint?.('journal_complete');
  } finally { await handle.close(); }
  try {
    await mkdir(staging, { mode: 0o700 });
    if (exists) await fs.rename(destination, backup);
    try { await lstat(destination); throw new WorkspaceError('The destination already exists.'); }
    catch (error) { if (!isNodeError(error, 'ENOENT')) throw error; }
    let copied = false;
    try { await fs.rename(source, destination); }
    catch (error) {
      if (!isNodeError(error, 'EXDEV')) throw error;
      await fs.cp(source, copy, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await fs.rename(copy, destination);
      copied = true;
    }
    if (copied) await fs.rm(source, { recursive: true });
    await fs.rm(staging, { recursive: true, force: true });
    await fs.checkpoint?.('before_journal_unlink');
    await unlink(journalPath);
    await fs.checkpoint?.('after_journal_unlink');
  } catch {
    throw new WorkspaceError('Workspace move was interrupted or failed. Data was retained where possible; use get_operator_workspace_move_status and inspect manually.');
  }
}

function boundedInteger(value: ConductorJsonValue | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new WorkspaceError(`${name} must be an integer between 1 and ${max}.`);
  return value;
}

async function existingWorkspaceParent(root: string, parts: string[]): Promise<string> {
  const parent = await realpath(resolve(root, ...parts));
  assertWithinWorkspace(root, parent);
  if (!(await stat(parent)).isDirectory()) throw new WorkspaceError('A workspace path component is not a directory.');
  return parent;
}

/** watch is owned by the running operator-agent, outside the file tool queue. */
async function protectWatch(root: string, candidate: string, protectAncestors = false): Promise<void> {
  const relativePath = relative(root, candidate);
  const firstPart = relativePath.split(sep)[0]?.toLowerCase();
  if (firstPart === 'watch') throw new WorkspaceError('The operator watch directory is managed by the operator-agent and cannot be modified by workspace tools.');
  try {
    const canonicalWatch = await realpath(join(root, 'watch'));
    if (isWithin(canonicalWatch, candidate)) throw new WorkspaceError('The operator watch directory is managed by the operator-agent and cannot be modified by workspace tools.');
    if (protectAncestors && isWithin(candidate, canonicalWatch)) {
      throw new WorkspaceError('The operator watch directory or its parent cannot be modified by workspace tools.');
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw safeOperationError(error);
  }
}

function protectInstructions(root: string, path: string): void {
  if (path === join(root, 'AGENTS.md')) throw new WorkspaceError('The workspace AGENTS.md is protected from move and delete.');
}

class WorkspaceError extends Error {}

function safeOperationError(error: unknown): Error {
  if (error instanceof WorkspaceError) return error;
  return sanitizeFilesystemError(error);
}

function assertOnlyInputProperties(
  args: Record<string, ConductorJsonValue>,
  allowed: string[],
): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new WorkspaceError('The workspace file tool received an unexpected argument.');
  }
}

function resolveWorkspaceFilePath(
  root: string,
  value: ConductorJsonValue | undefined,
): WorkspaceFilePath {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceError('path must be a non-empty workspace-relative file path.');
  }
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw outsideWorkspaceError();
  }
  if (value.includes('\\')) {
    throw new WorkspaceError('Workspace file paths must use forward slashes.');
  }

  const parts = value
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.includes('..')) {
    throw outsideWorkspaceError();
  }
  if (parts.length === 0) {
    throw new WorkspaceError('path must name a file inside the operator profile workspace.');
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
    throw new WorkspaceError('The requested file does not exist inside the operator profile workspace.');
  }
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new WorkspaceError('The requested workspace path is not a file.');
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
  forbidden?: string,
): Promise<string> {
  let current = root;
  for (const part of parts) {
    const candidate = join(current, part);
    await protectWatch(root, candidate);
    if (forbidden && isWithin(forbidden, candidate)) throw new WorkspaceError('A directory cannot be moved into itself.');
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
    await protectWatch(root, canonicalPath);
    if (forbidden && isWithin(forbidden, canonicalPath)) throw new WorkspaceError('A directory cannot be moved into itself.');
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new WorkspaceError('A workspace path component is not a directory.');
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
  return new WorkspaceError(
    'The requested path is outside the active operator profile workspace. Use a relative path contained within that workspace.',
  );
}

function sanitizeFilesystemError(error: unknown): Error {
  if (isNodeError(error, 'ENOENT')) {
    return new WorkspaceError('The requested file or directory does not exist in the workspace.');
  }
  if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
    return new WorkspaceError('Permission was denied for the requested workspace file.');
  }
  if (isNodeError(error, 'ENOTDIR')) {
    return new WorkspaceError('A workspace path component is not a directory.');
  }
  if (isNodeError(error, 'ELOOP')) {
    return outsideWorkspaceError();
  }
  return new WorkspaceError('The workspace file operation failed.');
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
