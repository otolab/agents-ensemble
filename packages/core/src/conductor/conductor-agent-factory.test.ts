import { describe, expect, it } from 'vitest';
import { createConductorAgentFactory } from './conductor-agent-factory.js';

describe('createConductorAgentFactory', () => {
  it('selects an embedded factory for each supported conductor backend', async () => {
    const cursorFactory = createConductorAgentFactory('cursor');
    const piFactory = createConductorAgentFactory('pi');

    expect(cursorFactory).not.toBe(piFactory);
    expect(typeof cursorFactory.create).toBe('function');
    expect(typeof cursorFactory.resume).toBe('function');
    expect(typeof piFactory.create).toBe('function');
    expect(typeof piFactory.resume).toBe('function');
  });
});
