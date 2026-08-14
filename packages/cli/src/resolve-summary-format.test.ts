import { describe, expect, it } from 'vitest';
import { resolveIssueSummaryFormat } from './resolve-summary-format.js';

describe('resolveIssueSummaryFormat', () => {
  it('uses text on TTY when auto', () => {
    expect(resolveIssueSummaryFormat({ summaryFormat: 'auto', isTty: true })).toBe(
      'text',
    );
  });

  it('uses json on non-TTY when auto', () => {
    expect(resolveIssueSummaryFormat({ summaryFormat: 'auto', isTty: false })).toBe(
      'json',
    );
  });

  it('honors explicit json and text', () => {
    expect(resolveIssueSummaryFormat({ summaryFormat: 'json', isTty: true })).toBe(
      'json',
    );
    expect(resolveIssueSummaryFormat({ summaryFormat: 'text', isTty: false })).toBe(
      'text',
    );
  });

  it('throws on invalid format', () => {
    expect(() =>
      resolveIssueSummaryFormat({ summaryFormat: 'yaml', isTty: false }),
    ).toThrow(/Invalid --summary-format/);
  });
});
