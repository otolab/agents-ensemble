import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [root, profile, configScope] = process.argv.slice(2);
if (!root || !profile) throw new Error('Missing scheduling writer arguments');
const directory = configScope
  ? join(root, 'operator-agents', '.config-scopes', configScope, profile)
  : join(root, 'operator-agents', profile);
const path = join(directory, 'scheduling-events.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;
let queue = Promise.resolve();

async function append(event: unknown): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, 'scheduling-events-lock.sqlite'));
  let locked = false;
  try {
    database.exec('PRAGMA busy_timeout = 0');
    for (let attempt = 0; attempt < 40; attempt++) {
      try { database.exec('BEGIN IMMEDIATE'); locked = true; break; }
      catch (error) {
        if (!(error instanceof Error) || !/database is locked|database is busy/iu.test(error.message)) throw error;
        if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!locked) throw new Error('Could not acquire scheduling event lock');
    const line = `${JSON.stringify(event)}\n`;
    try {
      if (statSync(path).size + Buffer.byteLength(line) > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    appendFileSync(path, line, { mode: 0o600 });
  } finally {
    try { if (locked) database.exec('ROLLBACK'); } finally { database.close(); }
  }
}

process.on('message', (message: { type?: string; event?: unknown; id?: number }) => {
  queue = queue.then(async () => {
    if (message.type === 'event') {
      try { await append(message.event); process.send?.({ type: 'event' }); }
      catch (error) { process.send?.({ type: 'event', message: error instanceof Error ? error.message : String(error) }); }
    } else if (message.type === 'barrier') {
      process.send?.({ type: 'barrier', id: message.id });
    }
  });
});
