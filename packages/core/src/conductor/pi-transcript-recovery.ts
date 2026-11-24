import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { piTranscriptStoreDir, type PiTranscriptPointerInput } from './pi-transcript-pointer.js';

/**
 * Called only while holding the pointer lock. Discard recognizable private
 * staging left by a terminated publisher. Keep all generation files (including
 * unreferenced ones) and any unexpected staging contents for inspection.
 */
export function recoverPiTranscriptStaging(input: PiTranscriptPointerInput): void {
  const store = piTranscriptStoreDir(input);
  const entries = (path: string) => {
    try { return readdirSync(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const removeStaging = (path: string, expectedFile: string) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const files = entries(path);
    if (files.length > 1 || (files.length === 1 &&
        (files[0]!.name !== expectedFile || !files[0]!.isFile() || files[0]!.isSymbolicLink()))) return;
    rmSync(path, { recursive: true });
  };
  for (const entry of entries(store)) {
    if (entry.name.startsWith('.pointer-') && entry.isDirectory()) {
      removeStaging(join(store, entry.name), 'current.json');
    } else if (entry.name.startsWith('.pi-read-') && entry.isDirectory()) {
      removeStaging(join(store, entry.name), 'session.jsonl');
    } else if (/^[a-f0-9]{32}$/.test(entry.name) && entry.isDirectory()) {
      const generationDir = join(store, entry.name);
      for (const child of entries(generationDir)) {
        if (child.name.startsWith('.pi-resume-') && child.isDirectory()) {
          removeStaging(join(generationDir, child.name), 'session.jsonl');
        }
      }
    }
  }
}
