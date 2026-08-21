import { accessSync, constants } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as bundledModule from './resolve-bundled-acp-bin.js';
import { resolveBundledAcpBin } from './resolve-bundled-acp-bin.js';

describe('resolve-bundled-acp-bin', () => {

  it('resolves bundled codex-acp when optional dependency is installed', () => {
    const bundled = resolveBundledAcpBin('codex');
    if (!bundled) {
      return;
    }
    expect(bundled).toMatch(/codex-acp/);
    accessSync(bundled, constants.X_OK);
  });

  it('resolves bundled claude-agent-acp when optional dependency is installed', () => {
    const bundled = resolveBundledAcpBin('claude');
    if (!bundled) {
      return;
    }
    expect(bundled).toMatch(/claude-agent-acp/);
    accessSync(bundled, constants.X_OK);
  });

  it('resolves bundled pi-acp when optional dependency is installed', () => {
    const bundled = resolveBundledAcpBin('pi');
    if (!bundled) {
      return;
    }
    expect(bundled).toMatch(/pi-acp/);
    accessSync(bundled, constants.X_OK);
  });

  it('resolves executable names from PATH', () => {
    const fromPath = bundledModule.resolveAcpBinFromPath('node');
    if (!fromPath) {
      return;
    }
    expect(fromPath.length).toBeGreaterThan(0);
  });
});
