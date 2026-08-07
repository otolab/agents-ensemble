import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasDispatchWorkerE2eConfig,
  loadDispatchWorkerE2eConfig,
} from './test-config.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');

describe.skipIf(!hasDispatchWorkerE2eConfig())('ensemble dispatch worker e2e', () => {
  it('runs CLI end-to-end', async () => {
    const config = loadDispatchWorkerE2eConfig()!;

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        CLI_ENTRY,
        'dispatch',
        'worker',
        config.issueUrl,
        '--skill',
        config.skillName,
        '--repo-root',
        config.repoRoot,
      ],
      {
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const result = JSON.parse(stdout) as { stopReason: string; worktree: string };
    expect(result.stopReason).toBeTruthy();
    expect(result.worktree).toContain('.ensemble/worktrees/issue-');
  }, 300_000);
});
