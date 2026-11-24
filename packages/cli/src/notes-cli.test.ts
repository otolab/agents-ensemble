import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    expect(run(['archive', note.id, '--slug', 'sample']).status).toBe(0);
    expect(JSON.parse(run(['list', '--slug', 'sample']).stdout).total).toBe(0);
    expect(run(['archive', note.id, '--slug', 'sample', '--archived', 'false']).status).toBe(0);
    expect(JSON.parse(run(['list', '--slug', 'sample']).stdout).total).toBe(1);
  }, 30000);
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
  it('returns usage and execution error codes', () => {
    expect(run(['push', '--slug', 'x', '--note', 'bad'], ' ').status).toBe(2);
    expect(run(['list', '--slug', 'x', '--limit', 'NaN']).status).toBe(2);
    expect(run(['show', 'bad', '--slug', 'x']).status).toBe(1);
    expect(run(['create', '--slug', 'x']).status).toBe(2);
  });
});
