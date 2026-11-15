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
