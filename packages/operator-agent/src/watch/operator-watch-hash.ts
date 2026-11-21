import { createHash } from 'node:crypto';

export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
