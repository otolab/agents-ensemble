import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const activeOwners = new WeakSet<SessionOwnership>();
// A failed teardown can leave callbacks running after their caller returns.
// Keep the connection reachable until process exit in that case.
const retainedOwners = new Set<SessionOwnership>();
const activeLeases = new WeakMap<SessionWriteLease, SessionOwnership>();
const leaseWrites = new WeakMap<SessionWriteLease, Set<Promise<unknown>>>();

async function assertUnaliasedFile(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1)) {
      throw new Error('Session resource file must not be a symlink or hard link');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** A capability valid only for the duration of one accepted write operation. */
export interface SessionWriteLease {
  readonly __sessionWriteLease: unique symbol;
}

export class SessionOwnershipUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Session is already in use or its previous cleanup could not be confirmed: ${path}. ` +
      'Stop the owning process before retrying. If cleanup failed in this process, restart it.',
      { cause },
    );
    this.name = 'SessionOwnershipUnavailableError';
  }
}

/** Exclusive ownership of one canonical session resume store. */
export class SessionOwnership {
  private acceptingWrites = true;
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private previousWrite: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly storePath: string,
    private readonly database: DatabaseSync,
    private readonly kind: 'session' | 'provider' = 'session',
  ) {}

  static async acquire(path: string): Promise<SessionOwnership> {
    return this.acquireResource(path, 'session');
  }

  static async acquireProvider(path: string): Promise<SessionOwnership> {
    return this.acquireResource(path, 'provider');
  }

  private static async acquireResource(path: string, kind: 'session' | 'provider'): Promise<SessionOwnership> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const canonicalPath = join(await realpath(dirname(path)), basename(path));
    if (kind === 'session') await assertUnaliasedFile(canonicalPath);
    const lockPath = `${canonicalPath}.${kind}.lock.sqlite`;
    const { DatabaseSync: SQLiteDatabase } = await import('node:sqlite');
    const database = new SQLiteDatabase(lockPath);
    try {
      await chmod(lockPath, 0o600);
      database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
      const owner = new SessionOwnership(canonicalPath, database, kind);
      activeOwners.add(owner);
      return owner;
    } catch (error) {
      database.close();
      if (
        typeof error === 'object' && error !== null &&
        'errcode' in error && typeof error.errcode === 'number' &&
        [5, 6].includes(error.errcode & 0xff)
      ) {
        throw new SessionOwnershipUnavailableError(canonicalPath, error);
      }
      throw error;
    }
  }

  assertActive(): void {
    if (!activeOwners.has(this)) throw new Error('Session ownership is not active');
  }

  async assertStorePath(path: string): Promise<void> {
    this.assertActive();
    const canonicalPath = join(await realpath(dirname(path)), basename(path));
    if (canonicalPath !== this.storePath) {
      throw new Error('Session ownership does not match the store path');
    }
  }

  async assertResourcePath(path: string, kind: 'store' | 'questions' | 'state' | 'history'): Promise<void> {
    this.assertActive();
    await assertUnaliasedFile(path);
    if (kind === 'store') {
      if (this.kind !== 'session') throw new Error('Session ownership is required');
      return this.assertStorePath(path);
    }
    if ((kind === 'state' || kind === 'history' || kind === 'questions') !== (this.kind === 'provider')) {
      throw new Error('Session ownership does not match the resource kind');
    }
    const name = basename(this.storePath).replace(/\.json$/, '');
    const base = dirname(this.storePath);
    const expected = kind === 'history'
      ? join(base, `${name}.tool-calls`)
      : join(base, name, kind === 'questions' ? 'open-questions.yaml' : 'session-state.yaml');
    const expectedParent = dirname(expected);
    await mkdir(expectedParent, { recursive: true, mode: 0o700 });
    const actual = join(await realpath(dirname(path)), basename(path));
    const canonicalParent = await realpath(expectedParent);
    if (canonicalParent !== expectedParent) {
      throw new Error('Session resource directory must not be a symlink');
    }
    const canonicalExpected = join(canonicalParent, basename(expected));
    if (actual !== canonicalExpected) {
      throw new Error('Session ownership does not match the resource path');
    }
  }

  retainUntilProcessExit(): void {
    this.assertActive();
    this.acceptingWrites = false;
    retainedOwners.add(this);
  }

  assertLease(lease: SessionWriteLease): void {
    this.assertActive();
    if (activeLeases.get(lease) !== this) {
      throw new Error('Session write lease is invalid or expired');
    }
  }

  writeWithLease<T>(
    lease: SessionWriteLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLease(lease);
    const writes = leaseWrites.get(lease)!;
    const write = Promise.resolve().then(operation);
    writes.add(write);
    void write.then(
      () => writes.delete(write),
      () => writes.delete(write),
    );
    return write;
  }

  private assertAccepting(): void {
    this.assertActive();
    if (!this.acceptingWrites) throw new Error('Session ownership is no longer accepting writes');
  }

  runWrite<T>(operation: (lease: SessionWriteLease) => Promise<T>): Promise<T> {
    try {
      this.assertAccepting();
    } catch (error) {
      return Promise.reject(error);
    }
    // Register synchronously before the operation can yield or the gate closes.
    const lease = {} as SessionWriteLease;
    activeLeases.set(lease, this);
    const writes = new Set<Promise<unknown>>();
    leaseWrites.set(lease, writes);
    const write = this.previousWrite.catch(() => undefined).then(async () => {
      try {
        return await operation(lease);
      } finally {
        while (writes.size > 0) {
          await Promise.allSettled([...writes]);
        }
        activeLeases.delete(lease);
        leaseWrites.delete(lease);
      }
    });
    this.previousWrite = write;
    this.pendingWrites.add(write);
    void write.then(
      () => this.pendingWrites.delete(write),
      () => this.pendingWrites.delete(write),
    );
    return write;
  }

  /** Reserve both gates synchronously; neither can close between reservations. */
  runJointWrite<T>(other: SessionOwnership, operation: (first: SessionWriteLease, second: SessionWriteLease) => Promise<T>): Promise<T> {
    try {
      this.assertAccepting();
      other.assertAccepting();
      if (other === this) throw new Error('Joint write requires distinct owners');
    } catch (error) {
      return Promise.reject(error);
    }
    let provide!: (lease: SessionWriteLease) => void;
    const providerLease = new Promise<SessionWriteLease>((resolve) => { provide = resolve; });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const providerWrite = other.runWrite(async (lease) => {
      provide(lease);
      await finished;
    });
    const write = this.runWrite(async (lease) => {
      try {
        return await operation(lease, await providerLease);
      } finally {
        finish();
      }
    });
    void providerWrite.catch(() => {});
    return write;
  }

  async closeWritesAndDrain(): Promise<void> {
    this.assertActive();
    this.acceptingWrites = false;
    await Promise.allSettled([...this.pendingWrites]);
  }

  release(): void {
    this.assertActive();
    if (retainedOwners.has(this)) {
      throw new Error('Session ownership is retained until process exit');
    }
    if (this.acceptingWrites || this.pendingWrites.size !== 0) {
      throw new Error('Close and drain session writes before releasing ownership');
    }
    activeOwners.delete(this);
    try {
      this.database.exec('ROLLBACK');
    } finally {
      this.database.close();
    }
  }
}
