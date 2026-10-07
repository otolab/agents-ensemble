import { describe, expect, it } from 'vitest';
import {
  getPiHeadlessSettingsManagerOverrides,
  PI_HEADLESS_SETTING_DEFINITIONS,
} from './pi-headless-settings.js';

describe('Pi headless settings contract', () => {
  it('keeps the settings-manager channel limited to compaction and branch summary', () => {
    expect(
      PI_HEADLESS_SETTING_DEFINITIONS.filter(
        (definition) => definition.channel === 'settings-manager-override',
      ).map((definition) => definition.key),
    ).toEqual(['compaction', 'branchSummary']);
  });

  it('filters unsupported keys before crossing the Pi SDK settings boundary', () => {
    expect(
      getPiHeadlessSettingsManagerOverrides({
        compaction: {
          enabled: false,
          reserveTokens: 1_000,
          unsupportedNestedKey: 'ignored',
          modelOverrides: {
            'provider/model': {
              keepRecentTokens: 2_000,
              unsupportedNestedKey: 'ignored',
            },
          },
        },
        branchSummary: {
          reserveTokens: 3_000,
          skipPrompt: true,
          unsupportedNestedKey: 'ignored',
        },
        retry: { enabled: true },
        sessionDir: '/tmp/ignored',
        unknownFutureSetting: true,
      }),
    ).toEqual({
      compaction: {
        enabled: false,
        reserveTokens: 1_000,
        modelOverrides: {
          'provider/model': { keepRecentTokens: 2_000 },
        },
      },
      branchSummary: { reserveTokens: 3_000, skipPrompt: true },
    });
  });
});
