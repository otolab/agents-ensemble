import { describe, expect, it } from 'vitest';
import { AcpBridge } from '../../src/acp/acp-bridge.js';
import {
  acpTestConfigSkipReason,
  getAcpTestConfig,
} from './test-config.js';

const SUITE_NAME = acpTestConfigSkipReason
  ? `AcpBridge integration (skipped: ${acpTestConfigSkipReason})`
  : 'AcpBridge integration';

describe.skipIf(acpTestConfigSkipReason !== undefined)(SUITE_NAME, () => {
  it('runs a session against real agent acp', async () => {
    const config = getAcpTestConfig();
    const bridge = await AcpBridge.connect({
      command: config.agentCommand,
      args: config.agentArgs,
      cwd: config.cwd,
    });

    try {
      const result = await bridge.runSession({
        cwd: config.cwd ?? process.cwd(),
        prompt: 'Reply with exactly: pong',
      });
      expect(result.promptResult.stopReason).toBeTruthy();
    } finally {
      await bridge.close();
    }
  }, 120_000);
});
