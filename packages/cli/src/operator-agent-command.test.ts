import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('ensemble operator-agent command', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-agent-cli-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('rejects non-TTY invocation before starting an agent session', () => {
    const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cliEntry, 'operator-agent', '--repo-root', repoRoot],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ensemble operator-agent requires an interactive TTY',
    );
  });
});
