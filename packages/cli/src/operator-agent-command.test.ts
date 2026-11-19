import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('ensemble operator-agent command', () => {
  it('rejects non-TTY invocation before starting an agent session', () => {
    const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cliEntry, 'operator-agent'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'ensemble operator-agent requires an interactive TTY',
    );
  });

  it('shows operator profile, repository filters, and conversation selection options', () => {
    const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cliEntry, 'operator-agent', '--help'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--profile <name>');
    expect(result.stdout).toContain('--repo-filter <owner/repo|owner/*>');
    expect(result.stdout).toContain('--resume <operatorAgentId>');
    expect(result.stdout).toContain('--new');
    expect(result.stdout).not.toContain('--repo-root');
    expect(result.stdout).not.toContain('--config');
  });

  it('keeps --repo-root on the ensemble issue command', () => {
    const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cliEntry, 'issue', '--help'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--repo-root <path>');
  });
  it.skipIf(process.platform === 'win32')('preserves workspace maintenance behavior in a real TTY after a competing start', () => {
    const script = fileURLToPath(new URL('../test/fixtures/workspace-maintenance-tty.py', import.meta.url));
    const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const result = spawnSync('python3', [script, process.execPath, cliEntry], { encoding: 'utf8', timeout: 90_000 });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, 95_000);

});
