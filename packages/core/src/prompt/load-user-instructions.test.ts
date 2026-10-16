import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadUserInstructions,
  USER_INSTRUCTIONS_FILE,
} from './load-user-instructions.js';

describe('loadUserInstructions', () => {
  it('loads the optional user document from the shared user ensemble root', async () => {
    const userEnsembleRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-user-instructions-'),
    );
    await writeFile(
      join(userEnsembleRoot, USER_INSTRUCTIONS_FILE),
      '# Operator context\n\nPrefer concise status reports.\n',
    );

    await expect(loadUserInstructions({ userEnsembleRoot })).resolves.toEqual({
      id: 'user-instructions',
      title: 'User instructions (~/.ensemble/AGENTS.md)',
      content: '# Operator context\n\nPrefer concise status reports.',
    });
  });

  it('returns undefined when the optional document is missing or empty', async () => {
    const userEnsembleRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-user-instructions-'),
    );

    await expect(
      loadUserInstructions({ userEnsembleRoot }),
    ).resolves.toBeUndefined();

    await writeFile(join(userEnsembleRoot, USER_INSTRUCTIONS_FILE), ' \n\t ');
    await expect(
      loadUserInstructions({ userEnsembleRoot }),
    ).resolves.toBeUndefined();
  });

  it('fails with the path when the document exists but cannot be read as a file', async () => {
    const userEnsembleRoot = await mkdtemp(
      join(tmpdir(), 'ensemble-user-instructions-'),
    );
    const instructionsPath = join(userEnsembleRoot, USER_INSTRUCTIONS_FILE);
    await mkdir(instructionsPath);

    await expect(loadUserInstructions({ userEnsembleRoot })).rejects.toThrow(
      `Failed to read user instructions at ${instructionsPath}`,
    );
  });
});
