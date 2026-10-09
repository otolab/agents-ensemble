import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createProjectSkillCatalog } from './project-skill-catalog.js';

describe('createProjectSkillCatalog', () => {
  let repoRoot = '';

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
      repoRoot = '';
    }
  });

  async function initRepo(): Promise<string> {
    repoRoot = await mkdtemp(join(tmpdir(), 'project-skills-'));
    return repoRoot;
  }

  it('deduplicates by name with higher-priority roots winning', async () => {
    const root = await initRepo();
    await mkdir(join(root, '.codex', 'skills', 'review'), { recursive: true });
    await mkdir(join(root, '.agents', 'skills', 'review'), { recursive: true });
    await writeFile(
      join(root, '.codex', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: codex review\n---\ncodex body',
    );
    await writeFile(
      join(root, '.agents', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: agents review\n---\nagents body',
    );

    const catalog = createProjectSkillCatalog(root);
    const items = await catalog.load();

    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe('agents body');
    expect(items[0]?.root).toBe('.agents/skills');
    expect(items[0]?.shadows).toEqual([
      expect.objectContaining({
        root: '.codex/skills',
        filePath: join(root, '.codex', 'skills', 'review', 'SKILL.md'),
      }),
    ]);
  });

  it('search matches name and description', async () => {
    const root = await initRepo();
    await mkdir(join(root, '.cursor', 'skills', 'lint'), { recursive: true });
    await writeFile(
      join(root, '.cursor', 'skills', 'lint', 'SKILL.md'),
      '---\nname: lint-fix\ndescription: ESLint autofix flow\n---\nsteps',
    );

    const catalog = createProjectSkillCatalog(root);
    const matches = await catalog.search('eslint');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('lint-fix');
  });
});
