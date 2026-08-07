import { describe, expect, it } from 'vitest';
import { mergeConductorMaterials } from './materials.js';

describe('mergeConductorMaterials', () => {
  it('appends briefing as a material', () => {
    const materials = mergeConductorMaterials([], 'focus on tests');

    expect(materials).toEqual([
      {
        id: 'briefing',
        title: '作業基準メモ',
        content: 'focus on tests',
      },
    ]);
  });
});
