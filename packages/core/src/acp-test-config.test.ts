import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAcpTestConfigSkipReason,
  isAcpAgentCommandAvailable,
} from '../test/integration/test-config.js';

describe('ACP integration test config guard', () => {
  it('explains how to create a missing test-acp.yaml', () => {
    expect(getAcpTestConfigSkipReason(undefined)).toContain(
      'test-acp.yaml.example',
    );
  });

  it('skips when the configured agent command is unavailable', () => {
    const isAvailable = vi.fn(() => false);

    const reason = getAcpTestConfigSkipReason(
      { agentCommand: 'missing-agent', cwd: '/tmp/acp-test' },
      isAvailable,
    );

    expect(isAvailable).toHaveBeenCalledWith(
      'missing-agent',
      '/tmp/acp-test',
    );
    expect(reason).toContain('"missing-agent" is unavailable');
    expect(reason).toContain('agentCommand');
  });

  it('runs when the configured agent command is available', () => {
    expect(
      getAcpTestConfigSkipReason(
        { agentCommand: '/opt/agent' },
        () => true,
      ),
    ).toBeUndefined();
  });

  it('finds an executable command on PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ensemble-acp-test-'));
    const commandName = `agent-fixture-${process.pid}`;
    const extension =
      process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')[0]
        : '';
    const commandPath = join(directory, `${commandName}${extension}`);

    try {
      writeFileSync(commandPath, '#!/bin/sh\nexit 0\n');
      chmodSync(commandPath, 0o755);

      expect(
        isAcpAgentCommandAvailable(commandName, directory, directory),
      ).toBe(true);
      expect(
        isAcpAgentCommandAvailable(
          `${commandName}-missing`,
          directory,
          directory,
        ),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
