import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('smoke', () => {
  it('exports core package name', () => {
    expect(PACKAGE_NAME).toBe('@agents-ensemble/core');
  });
});
