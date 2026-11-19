import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOperatorWorkspaceFileTools,
  LIST_OPERATOR_WORKSPACE_FILES_TOOL,
  MOVE_OPERATOR_WORKSPACE_FILE_TOOL,
  DELETE_OPERATOR_WORKSPACE_FILE_TOOL,
  MAX_OPERATOR_WORKSPACE_FILE_BYTES,
  READ_OPERATOR_WORKSPACE_FILE_TOOL,
  resolveOperatorWorkspaceRoot,
  WRITE_OPERATOR_WORKSPACE_FILE_TOOL,
} from './operator-workspace-tools.js';

describe('operator profile workspace file tools', () => {
  let root = '';
  let workspace = '';
  let outside = '';
  let tools: ReturnType<typeof createOperatorWorkspaceFileTools>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ensemble-operator-workspace-'));
    workspace = join(root, 'operator-agents', 'work');
    outside = join(root, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    const canonicalRoot = await resolveOperatorWorkspaceRoot(workspace);
    tools = createOperatorWorkspaceFileTools(canonicalRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates parent directories and reads the written content back', async () => {
    const written = await tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
      path: 'notes/runbooks/triage.md',
      content: '# Triage\n\nCheck the current session first.\n',
    });
    const read = await tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
      path: 'notes/runbooks/triage.md',
    });

    expect(written.structuredContent).toEqual({
      path: 'notes/runbooks/triage.md',
      bytesWritten: Buffer.byteLength(
        '# Triage\n\nCheck the current session first.\n',
        'utf8',
      ),
    });
    expect(read.structuredContent).toEqual({
      path: 'notes/runbooks/triage.md',
      content: '# Triage\n\nCheck the current session first.\n',
    });
  });

  it('documents the same-user TOCTOU limitation in both tool descriptions', () => {
    for (const tool of [
      tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!,
      tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!,
    ]) {
      expect(tool.description).toContain(
        'do not prevent same-user TOCTOU changes between validation and path-based open',
      );
      expect(tool.description).toContain('not an OS sandbox');
    }
  });

  it('rejects parent traversal and absolute paths for both operations', async () => {
    const outsideFile = join(outside, 'private.txt');
    await writeFile(outsideFile, 'outside');

    for (const path of [
      '../outside/private.txt',
      'notes/../../outside/private.txt',
      outsideFile,
      '/etc/passwd',
      'C:\\Users\\operator\\private.txt',
    ]) {
      await expect(
        tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({ path }),
      ).rejects.toThrow(/outside the active operator profile workspace/u);
      await expect(
        tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
          path,
          content: 'blocked',
        }),
      ).rejects.toThrow(/outside the active operator profile workspace/u);
    }
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  it('rejects symlinks that resolve outside the workspace for reads and writes', async () => {
    const outsideFile = join(outside, 'private.txt');
    await writeFile(outsideFile, 'outside');
    const escapeLink = join(workspace, 'escape');
    await symlink(
      outside,
      escapeLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'escape/private.txt',
      }),
    ).rejects.toThrow(/outside the active operator profile workspace/u);
    await expect(
      tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'escape/new.txt',
        content: 'blocked',
      }),
    ).rejects.toThrow(/outside the active operator profile workspace/u);
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
    await expect(lstat(join(outside, 'new.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows a symlink whose resolved target remains in the workspace', async () => {
    await mkdir(join(workspace, 'source'));
    await writeFile(join(workspace, 'source', 'note.txt'), 'in workspace');
    await symlink(
      join(workspace, 'source'),
      join(workspace, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'alias/note.txt',
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        content: 'in workspace',
      },
    });
  });

  it('rejects read and write operations above the 1 MiB byte limit', async () => {
    const oversized = 'x'.repeat(MAX_OPERATOR_WORKSPACE_FILE_BYTES + 1);
    await writeFile(join(workspace, 'oversized.txt'), oversized);

    await expect(
      tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'oversized.txt',
      }),
    ).rejects.toThrow(/larger than 1048576 bytes/u);
    await expect(
      tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'too-large.txt',
        content: oversized,
      }),
    ).rejects.toThrow(/limited to 1048576 bytes/u);
    await expect(lstat(join(workspace, 'too-large.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('accepts exactly 1 MiB for reads and writes, measured in UTF-8 bytes', async () => {
    const exactLimit =
      'あ'.repeat(Math.floor(MAX_OPERATOR_WORKSPACE_FILE_BYTES / 3)) + 'x';
    expect(Buffer.byteLength(exactLimit, 'utf8')).toBe(
      MAX_OPERATOR_WORKSPACE_FILE_BYTES,
    );

    await writeFile(join(workspace, 'exact-read.txt'), exactLimit);
    const readResult = await tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute(
      { path: 'exact-read.txt' },
    );
    expect(readResult.structuredContent).toEqual({
      path: 'exact-read.txt',
      content: exactLimit,
    });

    const writeResult = await tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute(
      { path: 'exact-write.txt', content: exactLimit },
    );
    expect(writeResult.structuredContent).toEqual({
      path: 'exact-write.txt',
      bytesWritten: MAX_OPERATOR_WORKSPACE_FILE_BYTES,
    });
    await expect(
      readFile(join(workspace, 'exact-write.txt'), 'utf8'),
    ).resolves.toBe(exactLimit);
  });

  it('rejects input properties outside each tool schema at execution time', async () => {
    await expect(
      tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'note.txt',
        extra: 'ignored by schema',
      }),
    ).rejects.toThrow(/unexpected argument/u);
    await expect(
      tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({
        path: 'note.txt',
        content: 'safe',
        extra: 'ignored by schema',
      }),
    ).rejects.toThrow(/unexpected argument/u);
  });

  it('lists entries with bounded recursion and never follows symlinks', async () => {
    await mkdir(join(workspace, 'dir', 'nested'), { recursive: true });
    await writeFile(join(workspace, 'dir', 'nested', 'note'), 'hello');
    await symlink(outside, join(workspace, 'escape'), 'dir');
    const list = tools[LIST_OPERATOR_WORKSPACE_FILES_TOOL]!;
    const result = await list.execute({ recursive: true, maxDepth: 2 });
    expect(result.structuredContent?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dir', type: 'directory', size: expect.any(Number), mtime: expect.any(String) }),
      expect.objectContaining({ path: 'escape', type: 'symlink' }),
      expect.objectContaining({ path: 'dir/nested', type: 'directory' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('dir/nested/note');
    expect((await list.execute({ maxEntries: 1 })).structuredContent?.truncated).toBe(true);
    await expect(list.execute({ path: 'escape' })).rejects.toThrow(/outside/u);
    await expect(list.execute({ path: 'missing' })).rejects.toThrow(/does not exist/u);
  });

  it('moves files without overwrite and deletes files or symlinks safely', async () => {
    const move = tools[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const del = tools[DELETE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await writeFile(join(workspace, 'note'), 'content');
    await writeFile(join(workspace, 'existing'), 'keep');
    await expect(move.execute({ source: 'note', destination: 'existing' })).rejects.toThrow(/already exists/u);
    await move.execute({ source: 'note', destination: 'new/note' });
    await expect(readFile(join(workspace, 'new/note'), 'utf8')).resolves.toBe('content');
    await expect(del.execute({ path: 'new' })).rejects.toThrow(/not a file/u);
    await expect(move.execute({ source: 'new', destination: 'other' })).rejects.toThrow(/not a regular file/u);
    await expect(del.execute({ path: 'missing' })).rejects.toThrow(/does not exist/u);
    await expect(move.execute({ source: 'missing', destination: 'other' })).rejects.toThrow(/does not exist/u);
    await writeFile(join(workspace, 'AGENTS.md'), 'instructions');
    await expect(del.execute({ path: 'AGENTS.md' })).rejects.toThrow(/protected/u);
    await expect(move.execute({ source: 'AGENTS.md', destination: 'other' })).rejects.toThrow(/protected/u);
    await expect(del.execute({ path: '.' })).rejects.toThrow();
    await writeFile(join(outside, 'secret'), 'safe');
    await symlink(join(outside, 'secret'), join(workspace, 'link'));
    await expect(move.execute({ source: 'link', destination: 'other' })).rejects.toThrow(/not a regular file/u);
    await del.execute({ path: 'link' });
    await expect(readFile(join(outside, 'secret'), 'utf8')).resolves.toBe('safe');
    await del.execute({ path: 'new/note' });
  });

  it('rejects escapes through paths and symlinked parents', async () => {
    await writeFile(join(outside, 'secret'), 'safe');
    await writeFile(join(workspace, 'local'), 'local');
    await symlink(outside, join(workspace, 'escape'), 'dir');
    const move = tools[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const del = tools[DELETE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const list = tools[LIST_OPERATOR_WORKSPACE_FILES_TOOL]!;
    for (const path of ['../outside/secret', join(outside, 'secret'), 'escape/secret']) {
      await expect(del.execute({ path })).rejects.toThrow(/outside/u);
      await expect(move.execute({ source: path, destination: 'dest' })).rejects.toThrow(/outside/u);
      await expect(move.execute({ source: 'local', destination: path })).rejects.toThrow(/outside/u);
      await expect(list.execute({ path })).rejects.toThrow(/outside/u);
    }
    await expect(readFile(join(outside, 'secret'), 'utf8')).resolves.toBe('safe');
  });

  it('rejects a symlink as the profile workspace root', async () => {
    const linkedRoot = join(root, 'linked-workspace');
    await symlink(
      outside,
      linkedRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(resolveOperatorWorkspaceRoot(linkedRoot)).rejects.toThrow(
      /must be a real directory/u,
    );
  });
});
