import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConductorAgent } from '../../src/conductor/conductor-agent.js';
import { hasConductorAuth } from '../../src/conductor/conductor-auth.js';
import { getConductorModelId } from './test-config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe.skipIf(!hasConductorAuth())('ConductorAgent integration', () => {
  it('completes in agent mode with explicit finish text (not plan update)', async () => {
    const conductor = await ConductorAgent.create({
      cwd: REPO_ROOT,
      modelId: getConductorModelId(),
    });

    try {
      const result = await conductor.send(
        'これは接続テストです。ファイル編集・調査はせず、応答に conductor-ok とだけ含めて終了してください。',
      );

      expect(result.status).toBe('finished');
      expect(result.result).toContain('conductor-ok');
      expect(result.result).not.toMatch(/プランを更新/i);
      expect(result.error).toBeUndefined();
    } finally {
      await conductor.close();
    }
  }, 180_000);
});
