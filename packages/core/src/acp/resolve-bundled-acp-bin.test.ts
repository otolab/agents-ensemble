import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as bundledModule from './resolve-bundled-acp-bin.js';
import { resolveBundledAcpBin } from './resolve-bundled-acp-bin.js';

describe('resolve-bundled-acp-bin', () => {
  it.each([
    ['codex', /codex-acp/],
    ['claude', /claude-agent-acp/],
    ['pi', /pi-acp/],
  ] as const)(
    'returns an executable bundled %s binary when its optional dependency is available',
    (preset, expectedPath) => {
      const bundled = resolveBundledAcpBin(preset);
      if (bundled === undefined) {
        expect(bundled).toBeUndefined();
        return;
      }
      expect(bundled).toMatch(expectedPath);
      accessSync(bundled, constants.X_OK);
    },
  );

  it('resolves executable names from PATH', () => {
    const fromPath = bundledModule.resolveAcpBinFromPath('node');
    expect(fromPath).toBeDefined();
    expect(isAbsolute(fromPath!)).toBe(true);
    accessSync(fromPath!, constants.X_OK);
  });
});
