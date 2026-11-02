import { describe, expect, it } from 'vitest';
import { formatModelsListJson, formatModelsListNote, formatModelsListText } from './format-models-list.js';

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

  it('describes each backend and preserves the team restriction warning', () => {
    expect(formatModelsListNote('pi')).toContain('model registry');
    expect(formatModelsListNote('pi')).toContain('team 設定');
    expect(formatModelsListNote('cursor')).toContain('Cursor SDK カタログ');
    expect(formatModelsListNote('cursor')).toContain('team 設定');
  });
});
