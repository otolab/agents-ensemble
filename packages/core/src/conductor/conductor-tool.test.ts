import { describe, expect, it } from 'vitest';
import {
  ConductorToolRegistry,
  type ConductorTool,
} from './conductor-tool.js';

function createTool(name: string): ConductorTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object' },
    async execute() {
      return {
        content: [{ type: 'text', text: name }],
      };
    },
  };
}

describe('ConductorToolRegistry', () => {
  it('registers tools by their names and exposes them in insertion order', () => {
    const first = createTool('first');
    const second = createTool('second');
    const registry = new ConductorToolRegistry();

    registry.register(first).register(second);

    expect(registry.size).toBe(2);
    expect(registry.get('first')).toBe(first);
    expect(registry.has('second')).toBe(true);
    expect(registry.list()).toEqual([first, second]);
    expect(registry.toRecord()).toEqual({ first, second });
  });

  it('accepts an existing tool set', () => {
    const first = createTool('first');
    const second = createTool('second');

    const registry = new ConductorToolRegistry({ first, second });

    expect(registry.list()).toEqual([first, second]);
  });
});
