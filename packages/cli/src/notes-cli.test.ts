import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceNote, pushWorkspaceMemo } from '@agents-ensemble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
describe('notes CLI', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'notes-cli-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function run(args: string[], input?: string, env: Record<string, string> = {}) {
    const clean = { ...process.env, HOME: root, ENSEMBLE_USER_ROOT: join(root, 'user'), ...env };
    delete clean.ENSEMBLE_WORKSPACE_SLUG;
    delete clean.ENSEMBLE_WORKSPACE_REPO_ROOT;
    delete clean.ENSEMBLE_WORKSPACE_CONDUCTOR_CWD;
    Object.assign(clean, env);
    return spawnSync(process.execPath, [cli, 'notes', ...args, '--repo-root', root, '--json'], { cwd: root, env: clean, input, encoding: 'utf8' });
  }
  it('creates, pushes stdin, lists, reads, archives and restores via explicit slug', () => {
    const create = run(['create', '--slug', 'sample', '--summary', ' Test ']);
    expect(create.status, create.stderr).toBe(0);
    const note = JSON.parse(create.stdout);
    const push = run(['push', '--slug', 'sample', '--note', note.id], '  first memo\n');
    expect(push.status, push.stderr).toBe(0);
    const memo = JSON.parse(push.stdout);
    expect(memo.body).toBe('first memo');
    expect(JSON.parse(run(['list', '--slug', 'sample']).stdout).items[0].id).toBe(note.id);
    expect(JSON.parse(run(['show', note.id, '--slug', 'sample', '--history']).stdout).memos[0].id).toBe(memo.id);
    expect(run(['archive-memo', '--slug', 'sample', '--note', note.id, '--memo', memo.id]).status).toBe(0);
    expect(JSON.parse(run(['show', note.id, '--slug', 'sample', '--history']).stdout).memos).toHaveLength(0);
    const archived = JSON.parse(run(['show', note.id, '--slug', 'sample', '--history', '--include-archived']).stdout).memos[0];
    expect(archived).toMatchObject({ id: memo.id, body: 'first memo', archived: true });
    expect(run(['archive-memo', '--slug', 'sample', '--note', note.id, '--memo', archived.id, '--archived', 'false']).status).toBe(0);
    expect(JSON.parse(run(['show', note.id, '--slug', 'sample']).stdout).memos[0].id).toBe(memo.id);
    expect(run(['archive', note.id, '--slug', 'sample']).status).toBe(0);
    expect(JSON.parse(run(['list', '--slug', 'sample']).stdout).total).toBe(0);
    expect(run(['archive', note.id, '--slug', 'sample', '--archived', 'false']).status).toBe(0);
    expect(JSON.parse(run(['list', '--slug', 'sample']).stdout).total).toBe(1);
  }, 45000);
  it('requires an existing anchor for implicit lookup and never creates one', async () => {
    const result = run(['list']);
    expect(result.status).toBe(2);
    await expect(access(join(root, '.ensemble', 'workspace.json'))).rejects.toThrow();
    await mkdir(join(root, '.ensemble'));
    await writeFile(join(root, '.ensemble', 'workspace.json'), JSON.stringify({ slug: 'anchored' }));
    expect(run(['list']).status).toBe(0);
    expect(run(['list'], undefined, { ENSEMBLE_WORKSPACE_SLUG: 'injected' }).status).toBe(0);
    expect(run(['list', '--slug', '../bad']).status).toBe(2);
  });
  it('resolves explicit slug before injected slug before the anchor', async () => {
    await mkdir(join(root, '.ensemble'));
    await writeFile(join(root, '.ensemble', 'workspace.json'), JSON.stringify({ slug: 'anchor' }));
    const env = { ENSEMBLE_WORKSPACE_SLUG: 'injected' };
    expect(run(['create', '--slug', 'explicit', '--summary', 'explicit'], undefined, env).status).toBe(0);
    expect(run(['create', '--summary', 'injected'], undefined, env).status).toBe(0);
    expect(run(['create', '--summary', 'anchor']).status).toBe(0);
    expect(JSON.parse(run(['list', '--slug', 'explicit'], undefined, env).stdout).items[0].summary).toBe('explicit');
    expect(JSON.parse(run(['list'], undefined, env).stdout).items[0].summary).toBe('injected');
    expect(JSON.parse(run(['list']).stdout).items[0].summary).toBe('anchor');
  }, 30000);
  it('enforces trimmed UTF-8 stdin size and keeps error stdout empty', () => {
    const note = JSON.parse(run(['create', '--slug', 'size', '--summary', 'size']).stdout);
    const exact = run(['push', '--slug', 'size', '--note', note.id], ` \n${'é'.repeat(262144)}\n `);
    expect(exact.status, exact.stderr).toBe(0);
    const tooLarge = run(['push', '--slug', 'size', '--note', note.id], 'é'.repeat(262145));
    expect(tooLarge.status).toBe(2);
    expect(tooLarge.stdout).toBe('');
    expect(tooLarge.stderr).toContain('524288');
  }, 20000);
  it('caps list and history limits through the CLI', async () => {
    const userRoot = process.env.ENSEMBLE_USER_ROOT;
    process.env.ENSEMBLE_USER_ROOT = join(root, 'user');
    try {
      const scope = { repoRoot: root, slugKey: 'pages' };
      const notes = await Promise.all(Array.from({ length: 51 }, (_, i) => createWorkspaceNote({ ...scope, summary: `note ${i}` })));
      for (let i = 0; i < 101; i++) await pushWorkspaceMemo({ ...scope, noteId: notes[0]!.id, body: `memo ${i}` });
      expect(JSON.parse(run(['list', '--slug', 'pages', '--limit', '999']).stdout).items).toHaveLength(50);
      expect(JSON.parse(run(['show', notes[0]!.id, '--slug', 'pages', '--history', '--limit', '999']).stdout).memos).toHaveLength(100);
    } finally {
      if (userRoot === undefined) delete process.env.ENSEMBLE_USER_ROOT; else process.env.ENSEMBLE_USER_ROOT = userRoot;
    }
  }, 20000);
  it('returns usage and execution error codes', () => {
    expect(run(['push', '--slug', 'x', '--note', 'bad'], ' ').status).toBe(2);
    expect(run(['list', '--slug', 'x', '--limit', 'NaN']).status).toBe(2);
    expect(run(['show', 'bad', '--slug', 'x']).status).toBe(1);
    expect(run(['create', '--slug', 'x']).status).toBe(2);
  });
});
