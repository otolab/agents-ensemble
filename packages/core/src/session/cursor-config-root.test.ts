import { describe, expect, it } from 'vitest';
import { resolveCursorConfigRoot } from './cursor-config-root.js';

describe('resolveCursorConfigRoot', () => {
  it('uses XDG_CONFIG_HOME on Linux', () => {
    expect(
      resolveCursorConfigRoot({
        acpCwd: '/work/repository',
        platform: 'linux',
        xdgConfigHome: '/home/operator/.config',
        homeDirectory: '/home/operator',
      }),
    ).toBe('/home/operator/.config/cursor');
  });

  it('uses XDG_CONFIG_HOME on BSD', () => {
    expect(
      resolveCursorConfigRoot({
        acpCwd: '/work/repository',
        platform: 'freebsd',
        xdgConfigHome: '/home/operator/.config',
        homeDirectory: '/home/operator',
      }),
    ).toBe('/home/operator/.config/cursor');
  });

  it('uses the documented home root on macOS even when XDG_CONFIG_HOME is set', () => {
    expect(
      resolveCursorConfigRoot({
        acpCwd: '/Users/operator/work',
        platform: 'darwin',
        xdgConfigHome: '/Users/operator/.config',
        homeDirectory: '/Users/operator',
      }),
    ).toBe('/Users/operator/.cursor');
  });

  it('uses USERPROFILE home on Windows even when XDG_CONFIG_HOME is set', () => {
    expect(
      resolveCursorConfigRoot({
        acpCwd: 'C:\\work\\repository',
        platform: 'win32',
        xdgConfigHome: 'C:\\Users\\operator\\AppData\\Roaming',
        homeDirectory: 'C:\\Users\\operator',
      }),
    ).toBe('C:\\Users\\operator\\.cursor');
  });

  it('honors CURSOR_CONFIG_DIR before platform defaults', () => {
    expect(
      resolveCursorConfigRoot({
        acpCwd: 'C:\\work\\repository',
        platform: 'win32',
        cursorConfigDir: '..\\cursor-data',
        xdgConfigHome: 'C:\\Users\\operator\\AppData\\Roaming',
        homeDirectory: 'C:\\Users\\operator',
      }),
    ).toBe('C:\\work\\cursor-data');
  });
});
