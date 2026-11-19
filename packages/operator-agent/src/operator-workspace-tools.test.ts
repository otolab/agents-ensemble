import {
  lstat,
  cp,
  rename,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
  GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL,
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
    await expect(move.execute({ source: 'new', destination: 'new/child' })).rejects.toThrow(/itself/u);
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

  it('moves directories, requires explicit overwrite, and protects root and AGENTS.md', async () => {
    const move = tools[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const del = tools[DELETE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await mkdir(join(workspace, 'folder', 'sub'), { recursive: true });
    await writeFile(join(workspace, 'folder', 'sub', 'note'), 'source');
    await mkdir(join(workspace, 'target'));
    await writeFile(join(workspace, 'target', 'old'), 'old');
    await expect(move.execute({ source: 'folder', destination: 'target' })).rejects.toThrow(/already exists/u);
    await expect(move.execute({ source: 'folder', destination: 'folder/new/child' })).rejects.toThrow(/itself/u);
    await expect(lstat(join(workspace, 'folder/new'))).rejects.toMatchObject({ code: 'ENOENT' });
    await symlink(join(workspace, 'folder'), join(workspace, 'alias'), 'dir');
    await expect(move.execute({ source: 'folder', destination: 'alias/child' })).rejects.toThrow(/itself/u);
    await move.execute({ source: 'folder', destination: 'target', overwrite: true });
    await expect(readFile(join(workspace, 'target/sub/note'), 'utf8')).resolves.toBe('source');
    await expect(lstat(join(workspace, 'target/old'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(workspace, 'file'), 'new');
    await writeFile(join(workspace, 'other'), 'old');
    await move.execute({ source: 'file', destination: 'other', overwrite: true });
    await expect(readFile(join(workspace, 'other'), 'utf8')).resolves.toBe('new');
    await writeFile(join(workspace, 'AGENTS.md'), 'protected');
    await expect(move.execute({ source: 'other', destination: 'AGENTS.md', overwrite: true })).rejects.toThrow(/protected/u);
    await expect(move.execute({ source: '.', destination: 'other', overwrite: true })).rejects.toThrow();
    await expect(del.execute({ path: '.' })).rejects.toThrow();
    await expect(readFile(join(workspace, 'AGENTS.md'), 'utf8')).resolves.toBe('protected');
    await expect(move.execute({ source: 'other', destination: 'x', overwrite: 'yes' })).rejects.toThrow(/boolean/u);
  });

  it('handles cross-filesystem moves and reports partial source removal', async () => {
    await mkdir(join(workspace, 'source'));
    await writeFile(join(workspace, 'source/note'), 'source');
    await writeFile(join(workspace, 'source/partial'), 'partial');
    await mkdir(join(workspace, 'dest'));
    await writeFile(join(workspace, 'dest/old'), 'old');
    const sourcePath = await realpath(join(workspace, 'source'));
    const fakeFs = {
      rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
        if (String(from) === sourcePath) throw Object.assign(new Error('private path'), { code: 'EXDEV' });
        return rename(from, to);
      },
      cp,
      rm: async (path: Parameters<typeof rm>[0], options?: Parameters<typeof rm>[1]) => {
        if (String(path) === sourcePath) {
          await rm(join(sourcePath, 'partial'));
          throw Object.assign(new Error('private path'), { code: 'EACCES' });
        }
        return rm(path, options);
      },
    };
    const move = createOperatorWorkspaceFileTools(await resolveOperatorWorkspaceRoot(workspace), fakeFs)[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await expect(move.execute({ source: 'source', destination: 'dest', overwrite: true })).rejects.toThrow(/inspect manually/u);
    await expect(readFile(join(workspace, 'dest/note'), 'utf8')).resolves.toBe('source');
    await expect(readFile(join(workspace, 'source/note'), 'utf8')).resolves.toBe('source');
    await expect(lstat(join(workspace, 'source/partial'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, 'dest/partial'), 'utf8')).resolves.toBe('partial');
    const staging = (await import('node:fs/promises')).readdir(workspace);
    const backup = (await staging).find((entry) => entry.startsWith('.ensemble-move-'))!;
    await expect(readFile(join(workspace, backup, 'backup/old'), 'utf8')).resolves.toBe('old');
  });

  it('preserves the previous destination on failed move and blocks further operations', async () => {
    await writeFile(join(workspace, 'source'), 'source');
    await writeFile(join(workspace, 'dest'), 'old');
    const sourcePath = await realpath(join(workspace, 'source'));
    const fakeFs = {
      rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
        if (String(from) === sourcePath) throw Object.assign(new Error('/secret/private'), { code: 'EACCES' });
        return rename(from, to);
      }, cp, rm,
    };
    const move = createOperatorWorkspaceFileTools(await resolveOperatorWorkspaceRoot(workspace), fakeFs)[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await expect(move.execute({ source: 'source', destination: 'dest', overwrite: true })).rejects.toThrow(/inspect manually/u);
    await expect(readFile(join(workspace, 'source'), 'utf8')).resolves.toBe('source');
    const staging = (await (await import('node:fs/promises')).readdir(workspace)).find((name) => name.startsWith('.ensemble-move-'))!;
    await expect(readFile(join(workspace, staging, 'backup'), 'utf8')).resolves.toBe('old');
    await expect(tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({ path: 'source' })).rejects.toThrow(/manual inspection/u);
    const status = await tools[GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL]!.execute({});
    expect(status.structuredContent).toMatchObject({ status: 'inspection_required', source: 'source', destination: 'dest' });
  });

  it('copies across filesystems and preserves the source if copying fails', async () => {
    const source = join(await realpath(workspace), 'source');
    const fakeRename = async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (String(from) === source) throw Object.assign(new Error('private'), { code: 'EXDEV' });
      return rename(from, to);
    };
    await writeFile(source, 'source');
    const failCopy = async () => { throw Object.assign(new Error('/private/secret'), { code: 'EIO' }); };
    const failing = createOperatorWorkspaceFileTools(await realpath(workspace), { rename: fakeRename, cp: failCopy, rm })[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await expect(failing.execute({ source: 'source', destination: 'target' })).rejects.toThrow(/inspect manually/u);
    await expect(readFile(source, 'utf8')).resolves.toBe('source');
    await expect(lstat(join(workspace, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
    const journalName = (await (await import('node:fs/promises')).readdir(join(workspace, '..'))).find((name) => name.startsWith('.ensemble-workspace-move-'))!;
    await rm(join(workspace, '..', journalName));
    const move = createOperatorWorkspaceFileTools(await realpath(workspace), { rename: fakeRename, cp, rm })[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await move.execute({ source: 'source', destination: 'target' });
    await expect(readFile(join(workspace, 'target'), 'utf8')).resolves.toBe('source');
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports recovery location when a destination appears during rollback', async () => {
    const rootPath = await realpath(workspace);
    const source = join(rootPath, 'source');
    const dest = join(rootPath, 'dest');
    await writeFile(source, 'source');
    await writeFile(dest, 'old');
    const fakeRename = async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (String(from) === source) {
        await writeFile(dest, 'concurrent');
        throw Object.assign(new Error('private'), { code: 'EACCES' });
      }
      return rename(from, to);
    };
    const move = createOperatorWorkspaceFileTools(rootPath, { rename: fakeRename, cp, rm })[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    await expect(move.execute({ source: 'source', destination: 'dest', overwrite: true })).rejects.toThrow(/inspect manually/u);
    await expect(readFile(dest, 'utf8')).resolves.toBe('concurrent');
    const entries = await (await import('node:fs/promises')).readdir(rootPath);
    const backup = entries.find((entry) => entry.startsWith('.ensemble-move-'))!;
    await expect(readFile(join(rootPath, backup, 'backup'), 'utf8')).resolves.toBe('old');
    await expect(readFile(source, 'utf8')).resolves.toBe('source');
  });

  it('serializes competing moves in one instance and preserves both files', async () => {
    await writeFile(join(workspace, 'a'), 'A');
    await writeFile(join(workspace, 'b'), 'B');
    const move = tools[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const results = await Promise.allSettled([
      move.execute({ source: 'a', destination: 'dest' }),
      move.execute({ source: 'b', destination: 'dest' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await expect(readFile(join(workspace, 'dest'), 'utf8')).resolves.toBe('A');
    await expect(readFile(join(workspace, 'b'), 'utf8')).resolves.toBe('B');
  });

  it('fails closed on an unreadable move record without changing workspace data', async () => {
    await writeFile(join(workspace, 'source'), 'safe');
    const { createHash } = await import('node:crypto');
    const canonical = await realpath(workspace);
    const hash = createHash('sha256').update(canonical).digest('hex');
    await writeFile(join(canonical, '..', `.ensemble-workspace-move-${hash}.json`), '{');
    const status = await tools[GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL]!.execute({});
    expect(status.structuredContent?.status).toBe('journal_unreadable');
    for (const [name, args] of [
      [READ_OPERATOR_WORKSPACE_FILE_TOOL, { path: 'source' }],
      [WRITE_OPERATOR_WORKSPACE_FILE_TOOL, { path: 'source', content: 'changed' }],
      [LIST_OPERATOR_WORKSPACE_FILES_TOOL, {}],
      [MOVE_OPERATOR_WORKSPACE_FILE_TOOL, { source: 'source', destination: 'dest' }],
      [DELETE_OPERATOR_WORKSPACE_FILE_TOOL, { path: 'source' }],
    ] as const) await expect(tools[name]!.execute(args)).rejects.toThrow(/manual inspection/u);
    await expect(readFile(join(workspace, 'source'), 'utf8')).resolves.toBe('safe');
  });

  it('preserves and identifies an interrupted overwrite after process termination', async () => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const canonical = await realpath(workspace);
    await writeFile(join(workspace, 'source'), 'source');
    await writeFile(join(workspace, 'dest'), 'old');
    const moduleUrl = new URL('../dist/operator-workspace-tools.js', import.meta.url).href;
    const script = `
      import { createOperatorWorkspaceFileTools } from ${JSON.stringify(moduleUrl)};
      import { rename, cp, rm } from 'node:fs/promises';
      import { join } from 'node:path';
      const root = process.argv[1];
      const fake = { cp, rm, rename: async (from, to) => {
        if (String(from) === join(root, 'source')) {
          console.log('ready');
          await new Promise(() => {});
        }
        return rename(from, to);
      }};
      await createOperatorWorkspaceFileTools(root, fake).move_operator_workspace_file.execute({ source: 'source', destination: 'dest', overwrite: true });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, canonical], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      child.kill('SIGKILL');
      await once(child, 'exit');
      const status = await tools[GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL]!.execute({});
      expect(status.structuredContent).toMatchObject({ status: 'inspection_required', source: 'source', destination: 'dest', overwrite: true });
      const staging = status.structuredContent?.staging as string;
      await expect(readFile(join(workspace, staging, 'backup'), 'utf8')).resolves.toBe('old');
      await expect(readFile(join(workspace, 'source'), 'utf8')).resolves.toBe('source');
      await expect(lstat(join(workspace, 'dest'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(tools[LIST_OPERATOR_WORKSPACE_FILES_TOOL]!.execute({})).rejects.toThrow(/manual inspection/u);
    } finally { child.kill('SIGKILL'); }
  });

  it.each(['before_rename', 'after_rename', 'partial_copy', 'copy_complete', 'after_publish', 'partial_remove', 'after_remove', 'cleanup'])(
    'preserves identifiable data after process termination at %s', async (stage) => {
      const { spawn } = await import('node:child_process');
      const { once } = await import('node:events');
      const canonical = await realpath(workspace);
      await mkdir(join(workspace, 'source'));
      await writeFile(join(workspace, 'source', 'a'), 'A');
      await writeFile(join(workspace, 'source', 'b'), 'B');
      await mkdir(join(workspace, 'dest'));
      await writeFile(join(workspace, 'dest', 'old'), 'OLD');
      const moduleUrl = new URL('../dist/operator-workspace-tools.js', import.meta.url).href;
      const script = `
        import { createOperatorWorkspaceFileTools } from ${JSON.stringify(moduleUrl)};
        import { rename, cp, rm, mkdir, writeFile } from 'node:fs/promises';
        import { join, basename } from 'node:path';
        const [root, stage] = process.argv.slice(1);
        const pause = async () => { console.log('ready'); setInterval(() => {}, 1000); await new Promise(() => {}); };
        const source = join(root, 'source');
        const dest = join(root, 'dest');
        const cross = ['partial_copy', 'copy_complete', 'after_publish', 'partial_remove', 'after_remove'].includes(stage);
        const fake = {
          rename: async (from, to) => {
            if (String(from) === source) {
              if (stage === 'before_rename') await pause();
              if (cross) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
              await rename(from, to);
              if (stage === 'after_rename') await pause();
              return;
            }
            await rename(from, to);
            if (basename(String(from)) === 'copy' && String(to) === dest && stage === 'after_publish') await pause();
          },
          cp: async (from, to, options) => {
            if (stage === 'partial_copy') {
              await mkdir(to);
              await writeFile(join(to, 'a'), 'A');
              await pause();
            }
            await cp(from, to, options);
            if (stage === 'copy_complete') await pause();
          },
          rm: async (path, options) => {
            if (String(path) === source && stage === 'partial_remove') {
              await rm(join(source, 'a'));
              await pause();
            }
            if (basename(String(path)).startsWith('.ensemble-move-') && stage === 'cleanup') await pause();
            await rm(path, options);
            if (String(path) === source && stage === 'after_remove') await pause();
          },
        };
        await createOperatorWorkspaceFileTools(root, fake).move_operator_workspace_file.execute({ source: 'source', destination: 'dest', overwrite: true });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, canonical, stage], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await once(child.stdout, 'data');
        child.kill('SIGKILL');
        await once(child, 'exit');
        const status = await tools[GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL]!.execute({});
        expect(status.structuredContent).toMatchObject({ status: 'inspection_required', source: 'source', destination: 'dest' });
        const staging = status.structuredContent?.staging as string;
        await expect(readFile(join(workspace, staging, 'backup', 'old'), 'utf8')).resolves.toBe('OLD');
        if (stage === 'partial_copy' || stage === 'copy_complete') await expect(readFile(join(workspace, staging, 'copy', 'a'), 'utf8')).resolves.toBe('A');
        if (stage === 'partial_remove' || stage === 'after_publish' || stage === 'after_remove') {
          await expect(readFile(join(workspace, 'dest', 'a'), 'utf8')).resolves.toBe('A');
          await expect(readFile(join(workspace, 'dest', 'b'), 'utf8')).resolves.toBe('B');
        }
        if (stage === 'before_rename' || stage === 'partial_copy' || stage === 'copy_complete') await expect(readFile(join(workspace, 'source', 'b'), 'utf8')).resolves.toBe('B');
        if (stage === 'after_rename' || stage === 'cleanup') await expect(readFile(join(workspace, 'dest', 'b'), 'utf8')).resolves.toBe('B');
        await expect(tools[LIST_OPERATOR_WORKSPACE_FILES_TOOL]!.execute({})).rejects.toThrow(/manual inspection/u);
      } finally { child.kill('SIGKILL'); }
    }, 15000,
  );

  it.each(['journal_open', 'journal_partial', 'journal_complete', 'before_journal_unlink', 'after_journal_unlink'])(
    'handles process termination at %s', async (stage) => {
      const { spawn } = await import('node:child_process');
      const { once } = await import('node:events');
      const canonical = await realpath(workspace);
      await writeFile(join(workspace, 'source'), 'SOURCE');
      await writeFile(join(workspace, 'dest'), 'OLD');
      const moduleUrl = new URL('../dist/operator-workspace-tools.js', import.meta.url).href;
      const script = `
        import { createOperatorWorkspaceFileTools } from ${JSON.stringify(moduleUrl)};
        import { rename, cp, rm } from 'node:fs/promises';
        const [root, stage] = process.argv.slice(1);
        const fake = { rename, cp, rm, checkpoint: async (point) => {
          if (point === stage) { console.log('ready'); setInterval(() => {}, 1000); await new Promise(() => {}); }
        }};
        await createOperatorWorkspaceFileTools(root, fake).move_operator_workspace_file.execute({ source: 'source', destination: 'dest', overwrite: true });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, canonical, stage], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await once(child.stdout, 'data');
        child.kill('SIGKILL');
        await once(child, 'exit');
        const status = await tools[GET_OPERATOR_WORKSPACE_MOVE_STATUS_TOOL]!.execute({});
        if (stage === 'journal_open' || stage === 'journal_partial') {
          expect(status.structuredContent?.status).toBe('journal_unreadable');
          await expect(readFile(join(workspace, 'source'), 'utf8')).resolves.toBe('SOURCE');
          await expect(readFile(join(workspace, 'dest'), 'utf8')).resolves.toBe('OLD');
        } else if (stage === 'after_journal_unlink') {
          expect(status.structuredContent?.status).toBe('idle');
          await expect(readFile(join(workspace, 'dest'), 'utf8')).resolves.toBe('SOURCE');
        } else {
          expect(status.structuredContent).toMatchObject({ status: 'inspection_required', source: 'source', destination: 'dest' });
          if (stage === 'journal_complete') {
            await expect(readFile(join(workspace, 'source'), 'utf8')).resolves.toBe('SOURCE');
            await expect(readFile(join(workspace, 'dest'), 'utf8')).resolves.toBe('OLD');
          } else await expect(readFile(join(workspace, 'dest'), 'utf8')).resolves.toBe('SOURCE');
        }
        if (stage !== 'after_journal_unlink') await expect(tools[LIST_OPERATOR_WORKSPACE_FILES_TOOL]!.execute({})).rejects.toThrow(/manual inspection/u);
      } finally { child.kill('SIGKILL'); }
    }, 15000,
  );

  it('preserves real watch pool updates while rejecting a move of its state', async () => {
    const { createOperatorWatchPool } = await import('./operator-watch-pool.js');
    const { createOperatorDispatchQueue } = await import('./operator-dispatch.js');
    const pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'work', dispatchQueue: createOperatorDispatchQueue(), autoDiscoverSessions: false });
    try {
      await pool.registerRepository('example/repo', { scanIntervalMs: 60000, pollIntervalMs: 60000 });
      const [update, move] = await Promise.allSettled([
        pool.registerRepository('example/repo', { scanIntervalMs: 90000, pollIntervalMs: 60000 }),
        tools[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({ source: 'watch', destination: 'archive' }),
      ]);
      expect(update.status).toBe('fulfilled');
      expect(move.status).toBe('rejected');
      const state = JSON.parse(await readFile(join(workspace, 'watch', 'repository-watch-state.json'), 'utf8'));
      expect(state.watches['example/repo'].scanIntervalMs).toBe(90000);
      await expect(lstat(join(workspace, 'archive'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { pool.close(); }
  });

  it('protects active watch data from mutations through direct paths and aliases', async () => {
    const watch = join(workspace, 'watch');
    await mkdir(watch);
    await writeFile(join(watch, 'watch-state.json'), 'before');
    await writeFile(join(watch, 'watch-state-lock.sqlite'), 'lock');
    await writeFile(join(workspace, 'note'), 'note');
    await symlink(watch, join(workspace, 'alias'), 'dir');
    await symlink(join(watch, 'watch-state.json'), join(workspace, 'state-alias'));
    const move = tools[MOVE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const write = tools[WRITE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const del = tools[DELETE_OPERATOR_WORKSPACE_FILE_TOOL]!;
    const update = writeFile(join(watch, 'watch-state.json'), 'updated by watch');
    await expect(move.execute({ source: 'watch', destination: 'archive' })).rejects.toThrow(/watch directory/u);
    await update;
    for (const path of ['watch', 'watch/watch-state.json', 'alias/watch-state.json']) {
      await expect(move.execute({ source: path, destination: 'archive' })).rejects.toThrow();
      await expect(del.execute({ path })).rejects.toThrow(/watch directory/u);
    }
    for (const path of ['watch/watch-state.json', 'alias/watch-state.json', 'state-alias']) {
      await expect(write.execute({ path, content: 'blocked' })).rejects.toThrow(/watch directory/u);
    }
    await expect(move.execute({ source: 'note', destination: 'alias/replaced', overwrite: true })).rejects.toThrow(/watch directory/u);
    await expect(readFile(join(watch, 'watch-state.json'), 'utf8')).resolves.toBe('updated by watch');
    await expect(readFile(join(watch, 'watch-state-lock.sqlite'), 'utf8')).resolves.toBe('lock');
    await expect(tools[READ_OPERATOR_WORKSPACE_FILE_TOOL]!.execute({ path: 'watch/watch-state.json' })).resolves.toMatchObject({ structuredContent: { content: 'updated by watch' } });
  });

  it('enforces list limit boundaries', async () => {
    const list = tools[LIST_OPERATOR_WORKSPACE_FILES_TOOL]!;
    for (const args of [{ maxDepth: 0 }, { maxDepth: 11 }, { maxEntries: 0 }, { maxEntries: 1001 }, { maxEntries: 1.5 }]) {
      await expect(list.execute(args)).rejects.toThrow(/integer/u);
    }
    await expect(list.execute({ maxDepth: 10, maxEntries: 1000 })).resolves.toBeDefined();
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
