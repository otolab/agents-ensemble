import React from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
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
});
