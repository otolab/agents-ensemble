import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultSlugKeyFromCwd,
  readWorkspaceAnchor,
  resolveWorkspaceSlugKey,
  workspaceSessionUrl,
} from './index.js';
import { parseWorkspaceSessionUrl } from './session-url.js';

describe('workspace slug-key', () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('derives stable hash slug from cwd', () => {
    const cwd = '/tmp/example-project';
    const a = defaultSlugKeyFromCwd(cwd);
    const b = defaultSlugKeyFromCwd(cwd + '/');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('writes and reads workspace anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-ws-'));
    temps.push(root);
    const slug = await resolveWorkspaceSlugKey({ cwd: root });
    const anchor = await readWorkspaceAnchor(root);
    expect(anchor?.slug).toBe(slug);
    const url = workspaceSessionUrl(slug);
    expect(parseWorkspaceSessionUrl(url)?.slugKey).toBe(slug);
  });

  it('persists explicit names and rejects replacing another anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-ws-'));
    temps.push(root);
    expect(await resolveWorkspaceSlugKey({ cwd: root, explicitName: 'named' })).toBe('named');
    expect(await resolveWorkspaceSlugKey({ cwd: root })).toBe('named');
    await expect(resolveWorkspaceSlugKey({ cwd: root, explicitName: 'other' })).rejects.toThrow('already anchored');
    expect((await readWorkspaceAnchor(root))?.slug).toBe('named');
  });
});
