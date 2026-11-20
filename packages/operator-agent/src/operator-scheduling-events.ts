import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

/** Called only while the profile watch-state lock is held. */
export function appendSchedulingEvent(
  root: string,
  profile: string,
  event: Record<string, unknown>,
  onError?: (message: string) => void,
): void {
  try {
    const directory = join(root, 'operator-agents', profile);
    const path = join(directory, 'scheduling-events.jsonl');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(event)}\n`;
    try {
      if (statSync(path).size + Buffer.byteLength(line) > MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    appendFileSync(path, line, { mode: 0o600 });
  } catch (error) {
    try {
      onError?.(`scheduling event write failed: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // Diagnostics must not affect scheduling either.
    }
  }
}
