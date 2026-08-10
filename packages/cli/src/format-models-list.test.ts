import { describe, expect, it } from 'vitest';
import { formatModelsListJson, formatModelsListText } from './format-models-list.js';

describe('formatModelsList', () => {
  it('formats models as aligned text', () => {
    const text = formatModelsListText([
      { id: 'default', displayName: 'Auto' },
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
    ]);

    expect(text).toBe('default       Auto\ncomposer-2.5  Composer 2.5');
  });

  it('formats models as JSON', () => {
    const json = formatModelsListJson([
      { id: 'default', displayName: 'Auto', aliases: ['auto'] },
    ]);

    expect(JSON.parse(json)).toEqual([
      { id: 'default', displayName: 'Auto', aliases: ['auto'] },
    ]);
  });
});
