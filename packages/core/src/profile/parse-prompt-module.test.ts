import { describe, expect, it } from 'vitest';
import { parsePromptModuleFromYaml } from './parse-prompt-module.js';

describe('parsePromptModuleFromYaml', () => {
  it('parses inline prompt sections and subsections', () => {
    const module = parsePromptModuleFromYaml(
      {
        persona: ['あなたは **worker** です。'],
        instructions: [
          'flat instruction',
          {
            type: 'subsection',
            title: 'tools',
            items: ['- use foo'],
          },
        ],
      },
      'test',
    );

    expect(module.persona).toEqual(['あなたは **worker** です。']);
    expect(module.instructions).toHaveLength(2);
  });

  it('rejects unknown sections', () => {
    expect(() =>
      parsePromptModuleFromYaml({ custom: ['x'] }, 'test'),
    ).toThrow(/unknown section/);
  });

  it('rejects empty prompt', () => {
    expect(() => parsePromptModuleFromYaml({}, 'test')).toThrow(/empty/);
  });

  it('rejects invalid subsection items', () => {
    expect(() =>
      parsePromptModuleFromYaml(
        {
          instructions: [
            {
              type: 'subsection',
              title: 'bad',
              items: [{ nested: true }],
            },
          ],
        },
        'test',
      ),
    ).toThrow(/must be a string/);
  });
});
