import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  buildTitledTopBorderLine,
  buildTitledTopBorderParts,
} from './titled-border-line.js';

describe('buildTitledTopBorderLine', () => {
  it('embeds title with spacing on round border', () => {
    const line = buildTitledTopBorderLine({
      title: 'Orchestration',
      totalWidth: 40,
      borderStyle: 'round',
    });

    expect(line.startsWith('╭─ Orchestration ─')).toBe(true);
    expect(line.endsWith('╮')).toBe(true);
    expect(stringWidth(line)).toBe(40);
  });

  it('appends suffix after title and truncates when too wide', () => {
    const line = buildTitledTopBorderLine({
      title: 'Orchestration',
      suffix: ' (PgUp/PgDn でスクロール · 最新へは End)',
      totalWidth: 50,
      borderStyle: 'round',
    });

    expect(line.startsWith('╭─ Orchestration')).toBe(true);
    expect(line).toContain('PgUp');
    expect(stringWidth(line)).toBe(50);
  });

  it('right-aligns titleRight before the closing corner', () => {
    const line = buildTitledTopBorderLine({
      title: 'Workers',
      titleRight: 'otolab/repo#263',
      totalWidth: 50,
      borderStyle: 'round',
    });

    expect(line.startsWith('╭─ Workers ─')).toBe(true);
    expect(line).toContain('otolab/repo#263');
    expect(line.endsWith('╮')).toBe(true);
    expect(stringWidth(line)).toBe(50);
    expect(line.indexOf('otolab/repo#263')).toBeGreaterThan(line.indexOf('Workers'));
  });

  it('truncates titleRight to the available visible width', () => {
    const parts = buildTitledTopBorderParts({
      title: 'Workers',
      titleRight: 'otolab/agents-ensemble#249',
      totalWidth: 24,
      borderStyle: 'round',
    });

    expect(parts.titleRight).toBe('otolab/a…');
    expect(stringWidth(`${parts.left}${parts.title}${parts.right}`)).toBe(24);
  });

  it('preserves a URL titleRight when truncation would change the target', () => {
    const canonicalIssueUrl = 'https://github.com/otolab/agents-ensemble/issues/249';
    const parts = buildTitledTopBorderParts({
      title: 'Workers',
      suffix: ' — conductor dispatch 保留中（3 件）',
      titleRight: canonicalIssueUrl,
      titleRightGap: ' ',
      preserveTitleRight: true,
      totalWidth: 24,
      borderStyle: 'round',
    });

    expect(parts.titleRight).toBe(canonicalIssueUrl);
    expect(`${parts.left}${parts.title}${parts.right}`).toContain(canonicalIssueUrl);
    expect(`${parts.left}${parts.title}${parts.right}`).not.toContain('https:/…');
  });

  it('uses single border characters when requested', () => {
    const line = buildTitledTopBorderLine({
      title: 'Operator input',
      totalWidth: 30,
      borderStyle: 'single',
    });

    expect(line.startsWith('┌─ Operator input ─')).toBe(true);
    expect(line.endsWith('┐')).toBe(true);
    expect(stringWidth(line)).toBe(30);
  });
});

describe('buildTitledTopBorderParts', () => {
  it('splits line into renderable segments', () => {
    const parts = buildTitledTopBorderParts({
      title: 'Workers',
      totalWidth: 20,
      borderStyle: 'round',
    });

    const line = `${parts.left}${parts.title}${parts.right}`;
    expect(parts.title).toBe('Workers');
    expect(stringWidth(line)).toBe(20);
  });
});
