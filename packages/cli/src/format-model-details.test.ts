import { describe, expect, it } from 'vitest';
import type { PiResolvedModelDetails } from '@agents-ensemble/core';
import { formatModelDetailsJson, formatModelDetailsText } from './format-model-details.js';

const DETAILS: PiResolvedModelDetails = {
  provider: 'local',
  id: 'review-model',
  name: 'Review model',
  contextWindow: 65536,
  contextWindowSource: 'models.json',
  maxTokens: 4096,
  modelSource: 'models.json',
  selection: {
    model: 'argument',
    provider: 'qualified-model',
  },
};

describe('model details formatter', () => {
  it('formats resolved details and states that provider limits are not verified', () => {
    const text = formatModelDetailsText(DETAILS);

    expect(text).toContain('provider: local');
    expect(text).toContain('id: review-model');
    expect(text).toContain('name: Review model');
    expect(text).toContain('contextWindow: 65536 tokens');
    expect(text).toContain('models.json');
    expect(text).toContain('provider 側の上限を検証した値ではありません');
  });

  it('emits the machine-readable detail fields as JSON', () => {
    expect(JSON.parse(formatModelDetailsJson(DETAILS))).toEqual(DETAILS);
  });

  it('reports an unavailable context window without inventing a value', () => {
    const text = formatModelDetailsText({
      ...DETAILS,
      contextWindow: null,
      contextWindowSource: 'unavailable',
    });

    expect(text).toContain('contextWindow: 取得できません (取得できません)');
    expect(JSON.parse(formatModelDetailsJson({
      ...DETAILS,
      contextWindow: null,
      contextWindowSource: 'unavailable',
    }))).toMatchObject({
      contextWindow: null,
      contextWindowSource: 'unavailable',
    });
  });

  it('escapes terminal controls in local model labels in text output', () => {
    const text = formatModelDetailsText({
      ...DETAILS,
      name: 'Review model\n\x1b[2J',
    });

    expect(text).toContain('name: Review model\\u000a\\u001b[2J');
  });
});
