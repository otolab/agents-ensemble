import { describe, expect, it, vi } from 'vitest';
import { createInteractiveInput } from './interactive-input.js';

describe('interactive input end', () => {
  for (const rawInitially of [false, true]) {
    for (const form of ['callback', 'chunk-callback', 'chunk-encoding-callback'] as const) {
      it(`${form} flushes keys before ending and calls back once (raw initially: ${rawInitially})`, async () => {
        const input = createInteractiveInput();
        const events: string[] = [];
        const callback = vi.fn(() => events.push('callback'));
        const finished = new Promise<void>((resolve, reject) => {
          input.on('data', (chunk) => events.push(`data:${String(chunk)}`));
          input.on('finish', () => events.push('finish'));
          input.on('end', () => { events.push('end'); resolve(); });
          input.on('error', reject);
        });
        if (rawInitially) input.setRawMode!(true);
        input.write('x\n');
        if (form === 'callback') input.end(callback);
        else if (form === 'chunk-callback') input.end('ab', callback);
        else input.end('ab', 'utf8', callback);
        if (!rawInitially) {
          expect(events).toEqual([]);
          expect(callback).not.toHaveBeenCalled();
          input.setRawMode!(true);
        }
        await finished;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events.filter((event) => event.startsWith('data:'))).toEqual(
          form === 'callback' ? ['data:x', 'data:\r'] : ['data:x', 'data:\r', 'data:a', 'data:b'],
        );
        expect(events.indexOf('finish')).toBeGreaterThan(events.lastIndexOf(form === 'callback' ? 'data:\r' : 'data:b'));
        expect(events.indexOf('callback')).toBeGreaterThan(
          events.lastIndexOf(form === 'callback' ? 'data:\r' : 'data:b'),
        );
        expect(callback).toHaveBeenCalledTimes(1);
        expect(events).toContain('end');
      });
    }
  }
});
