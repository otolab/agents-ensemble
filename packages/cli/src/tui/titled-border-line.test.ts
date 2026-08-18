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
