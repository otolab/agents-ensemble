import { chmod, copyFile, link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface PiResumeWorkCopy {
  /** Private working file. The caller must finish writing before committing. */
  workFile: string;
  /** Publish at the requested destination without replacing an existing file. */
  commit(): Promise<{ path: string; cleanupPending: boolean }>;
  /** Remove the working copy without publishing it. */
  discard(): Promise<void>;
}

/**
 * Prepare a copy beside its destination so publication uses one filesystem.
 * The source is never modified. The caller is responsible for excluding writers
 * while the source is copied and for stopping writes to the work file before
 * commit. This helper does not provide a lock, a consistent concurrent snapshot,
 * process-crash cleanup, or power-loss durability.
 *
 * Publication uses an exclusive hard link: an existing destination is never
 * replaced, even when another cooperating caller publishes concurrently. After
 * successful publication, interrupted cleanup can leave a staging directory;
 * the published file remains available independently of that directory.
 */
export async function createPiResumeWorkCopy(input: {
  sourceFile: string;
  destinationFile: string;
}): Promise<PiResumeWorkCopy> {
  const destinationFile = resolve(input.destinationFile);
  const destinationDir = dirname(destinationFile);
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(destinationDir, '.pi-resume-'));
  const workFile = join(workDir, 'session.jsonl');
  try {
    await copyFile(input.sourceFile, workFile);
    await chmod(workFile, 0o600);
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let state: 'active' | 'busy' | 'committed' | 'discarded' = 'active';
  const begin = (): void => {
    if (state !== 'active') throw new Error(`Pi resume work copy is ${state}.`);
    state = 'busy';
  };
  return {
    workFile,
    async commit() {
      begin();
      try {
        await link(workFile, destinationFile);
      } catch (error) {
        state = 'active';
        throw error;
      }
      // Once link succeeds, publication has happened even if cleanup fails.
      state = 'committed';
      let cleanupPending = false;
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        cleanupPending = true;
      }
      return { path: destinationFile, cleanupPending };
    },
    async discard() {
      begin();
      try {
        await rm(workDir, { recursive: true, force: true });
        state = 'discarded';
      } catch (error) {
        state = 'active';
        throw error;
      }
    },
  };
}
