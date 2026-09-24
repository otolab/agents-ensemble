import { describe, expect, it } from 'vitest';
import {
  createStreamScrollbackState,
  reduceStreamScrollback,
} from './stream-scrollback.js';

describe('stream scrollback reducer', () => {
  it('detaches at the current committed prefix and leaves later activity pending', () => {
    const initial = createStreamScrollbackState(3);
    const detached = reduceStreamScrollback(
      initial,
      { type: 'detached', source: 'keyboard' },
      3,
    );

    expect(detached).toEqual({ detached: true, committedActivityCount: 3 });
    expect(
      reduceStreamScrollback(detached, { type: 'detached', source: 'adapter' }, 5),
    ).toBe(detached);
  });

  it('flushes the complete suffix when returning to follow', () => {
    const detached = reduceStreamScrollback(
      createStreamScrollbackState(2),
      { type: 'detached', source: 'keyboard' },
      2,
    );

    expect(
      reduceStreamScrollback(detached, { type: 'follow', source: 'keyboard' }, 5),
    ).toEqual({ detached: false, committedActivityCount: 5 });
  });
});
