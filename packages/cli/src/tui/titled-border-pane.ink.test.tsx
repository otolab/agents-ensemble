import React from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { TitledBorderPane } from './titled-border-pane.js';

describe('TitledBorderPane', () => {
  it('renders embedded title on top border', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 40,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 10,
    });

    const { lastFrame } = render(
      <TitledBorderPane title="Workers" borderStyle="round" height={5}>
        <Text>hello</Text>
      </TitledBorderPane>,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Workers');
    expect(frame).toContain('hello');
    expect(frame).not.toMatch(/^│ Workers/m);
  });

  it('keeps a truncated Issue titleRight and OSC 8 target within a narrow width', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 24,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 10,
    });

    const issueUrl = 'http://github.com/otolab/agents-ensemble/issues/249/';
    const canonicalIssueUrl = 'https://github.com/otolab/agents-ensemble/issues/249';
    const fullIssueLabel = 'otolab/agents-ensemble#249';
    const truncatedIssueLabel = 'otolab/a…';
    const { lastFrame } = render(
      <TitledBorderPane
        title="Workers"
        titleRight={fullIssueLabel}
        titleRightIssueUrl={issueUrl}
        titleRightLinkMode="osc8"
        borderStyle="round"
        height={5}
      >
        <Text>hello</Text>
      </TitledBorderPane>,
    );

    const topBorderLine = (lastFrame() ?? '').split('\n')[0] ?? '';
    const osc8Open = `\u001b]8;;${canonicalIssueUrl}\u0007`;
    const osc8Close = '\u001b]8;;\u0007';
    const linkOpenIndex = topBorderLine.indexOf(osc8Open);
    const linkCloseIndex = topBorderLine.indexOf(
      osc8Close,
      linkOpenIndex + osc8Open.length,
    );
    const closingBorderIndex = topBorderLine.lastIndexOf('─╮');

    expect(topBorderLine).toContain(
      `${osc8Open}${truncatedIssueLabel}${osc8Close}`,
    );
    expect(topBorderLine).not.toContain(`\u001b]8;;${issueUrl}\u0007`);
    expect(topBorderLine).not.toContain(fullIssueLabel);
    expect(stringWidth(topBorderLine)).toBe(24);
    expect(linkOpenIndex).toBeGreaterThanOrEqual(0);
    expect(linkCloseIndex).toBeGreaterThan(linkOpenIndex + osc8Open.length);
    expect(linkCloseIndex).toBeLessThan(closingBorderIndex);
    expect(topBorderLine.slice(closingBorderIndex)).not.toContain(osc8Close);
    expect(topBorderLine.match(/\u001b\]8;;/g)).toHaveLength(2);
  });

  it('renders the canonical Issue URL with a plain separator in URL fallback mode', () => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 80,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 10,
    });

    const issueUrl = 'http://github.com/otolab/agents-ensemble/issues/249/';
    const canonicalIssueUrl = 'https://github.com/otolab/agents-ensemble/issues/249';
    const { lastFrame } = render(
      <TitledBorderPane
        title="Workers"
        titleRight="otolab/agents-ensemble#249"
        titleRightIssueUrl={issueUrl}
        titleRightLinkMode="url"
        borderStyle="round"
        height={5}
      >
        <Text>hello</Text>
      </TitledBorderPane>,
    );

    const topBorderLine = (lastFrame() ?? '').split('\n')[0] ?? '';
    expect(topBorderLine).toContain(`${canonicalIssueUrl} ─╮`);
    expect(topBorderLine).not.toContain('otolab/agents-ensemble#249');
    expect(topBorderLine).not.toContain('\u001b]8;;');
    expect(stringWidth(topBorderLine)).toBe(80);
  });
});
