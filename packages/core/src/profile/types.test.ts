import { describe, expect, it } from 'vitest';
import { filterMaterialsForKind } from './types.js';

describe('filterMaterialsForKind', () => {
  const materials = [
    { id: 'common', title: 'Common', content: 'common' },
    {
      id: 'implementer',
      title: 'Implementer',
      content: 'implementer',
      kinds: ['implementer'],
    },
    {
      id: 'reviewer',
      title: 'Reviewer',
      content: 'reviewer',
      kinds: ['reviewer'],
    },
    {
      id: 'worker-shared',
      title: 'Worker shared',
      content: 'worker shared',
      kinds: ['implementer', 'reviewer'],
    },
  ];

  it('keeps common and matching kind materials', () => {
    expect(filterMaterialsForKind(materials, 'implementer')).toEqual([
      materials[0],
      materials[1],
      materials[3],
    ]);
  });

  it('excludes materials for other kinds', () => {
    expect(filterMaterialsForKind(materials, 'reviewer')).toEqual([
      materials[0],
      materials[2],
      materials[3],
    ]);
  });

  it('returns no materials when there are no common or matching entries', () => {
    expect(
      filterMaterialsForKind(
        [
          {
            id: 'implementer',
            title: 'Implementer',
            content: 'implementer',
            kinds: ['implementer'],
          },
        ],
        'reviewer',
      ),
    ).toEqual([]);
  });
});
