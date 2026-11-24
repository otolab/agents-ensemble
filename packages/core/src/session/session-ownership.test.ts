import { spawn } from 'node:child_process';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { SessionOwnership, type SessionWriteLease } from './session-ownership.js';

it('excludes another owner through a directory alias and permits reacquisition', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-'));
  try {
    await symlink(dir, `${dir}-alias`, 'dir');
    const owner = await SessionOwnership.acquire(join(dir, 'session.json'));
    await expect(SessionOwnership.acquire(join(`${dir}-alias`, 'session.json'))).rejects.toThrow();
    await owner.closeWritesAndDrain();
    owner.release();
    const next = await SessionOwnership.acquire(join(dir, 'session.json'));
    await next.closeWritesAndDrain();
    next.release();
  } finally {
    await rm(`${dir}-alias`, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

it('releases the lock when the owning process is killed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-crash-'));
  const path = join(dir, 'session.json');
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { DatabaseSync } from 'node:sqlite';
     const db = new DatabaseSync(process.argv[1] + '.session.lock.sqlite');
     db.exec('BEGIN IMMEDIATE');
     console.log('ready');
     setInterval(() => {}, 1000);`,
    path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data');
    await expect(SessionOwnership.acquire(path)).rejects.toThrow();
    child.kill('SIGKILL');
    await once(child, 'exit');
    const owner = await SessionOwnership.acquire(path);
    await owner.closeWritesAndDrain();
    owner.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

it('retains ownership through garbage collection until process exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-retained-'));
  const path = join(dir, 'session.json');
  const modulePath = fileURLToPath(new URL('./session-ownership.ts', import.meta.url));
  const source = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const child = spawn(process.execPath, [
    '--expose-gc',
    '--input-type=module',
    '-e',
    `const { SessionOwnership } = await import(process.argv[1]);
     let owner = await SessionOwnership.acquire(process.argv[2]);
     owner.retainUntilProcessExit();
     owner = null;
     for (let i = 0; i < 10; i++) global.gc();
     await new Promise(resolve => setTimeout(resolve, 50));
     console.log('ready');
     setInterval(() => {}, 1000);`,
    moduleUrl,
    path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => { throw new Error('Owner process exited before acquiring lock'); }),
    ]);
    await expect(SessionOwnership.acquire(path)).rejects.toThrow(/restart it/);
    child.kill('SIGKILL');
    await once(child, 'exit');
    const owner = await SessionOwnership.acquire(path);
    await owner.closeWritesAndDrain();
    owner.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects late writes and waits for already accepted writes before release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-drain-'));
  try {
    const owner = await SessionOwnership.acquire(join(dir, 'session.json'));
    let finish!: () => void;
    const pending = owner.runWrite(() => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    const drained = owner.closeWritesAndDrain();
    await expect(owner.runWrite(async () => {})).rejects.toThrow(/no longer accepting/);
    expect(() => owner.release()).toThrow(/drain/);
    finish();
    await pending;
    await drained;
    owner.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('drains an accepted delayed file write before another owner can acquire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-write-'));
  const path = join(dir, 'session.json');
  try {
    const owner = await SessionOwnership.acquire(path);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const write = owner.runWrite(async () => {
      await gate;
      await writeFile(path, 'completed');
    });
    const drained = owner.closeWritesAndDrain();
    await expect(SessionOwnership.acquire(path)).rejects.toThrow();
    resume();
    await write;
    await drained;
    owner.release();
    const next = await SessionOwnership.acquire(path);
    expect(await readFile(path, 'utf8')).toBe('completed');
    await next.closeWritesAndDrain();
    next.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps a multi-write lease valid during drain and invalidates it afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-lease-'));
  const path = join(dir, 'session.json');
  try {
    const owner = await SessionOwnership.acquire(path);
    let resume!: () => void;
    let lease!: SessionWriteLease;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const write = owner.runWrite(async (accepted) => {
      lease = accepted;
      owner.assertLease(accepted);
      await writeFile(path, 'first');
      await gate;
      owner.assertLease(accepted);
      await writeFile(path, 'second');
    });
    await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('first'));
    const drained = owner.closeWritesAndDrain();
    await expect(owner.runWrite(async () => {})).rejects.toThrow(/no longer accepting/);
    resume();
    await write;
    await drained;
    expect(await readFile(path, 'utf8')).toBe('second');
    expect(() => owner.assertLease(lease)).toThrow(/expired/);
    owner.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('drains a lease write even if its enclosing operation does not await it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-owner-detached-'));
  const path = join(dir, 'session.json');
  try {
    const owner = await SessionOwnership.acquire(path);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let started = false;
    const operation = owner.runWrite(async (lease) => {
      void owner.writeWithLease(lease, async () => {
        started = true;
        await gate;
        await writeFile(path, 'completed');
      });
    });
    await vi.waitFor(() => expect(started).toBe(true));
    const drained = owner.closeWritesAndDrain();
    expect(() => owner.release()).toThrow(/drain/);
    resume();
    await operation;
    await drained;
    expect(await readFile(path, 'utf8')).toBe('completed');
    owner.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('reserves both owners before shutdown and drains the whole two-resource operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-joint-'));
  const session = await SessionOwnership.acquire(join(dir, 'harness.json'));
  const resource = await SessionOwnership.acquireProvider(join(dir, 'provider.json'));
  try {
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const operation = session.runJointWrite(resource, async (sessionLease, resourceLease) => {
      session.assertLease(sessionLease);
      resource.assertLease(resourceLease);
      entered();
      await gate;
      session.assertLease(sessionLease);
      resource.assertLease(resourceLease);
    });
    await started;
    const drains = Promise.all([session.closeWritesAndDrain(), resource.closeWritesAndDrain()]);
    await expect(session.runJointWrite(resource, async () => {})).rejects.toThrow(/no longer accepting/);
    expect(() => session.release()).toThrow(/drain/);
    expect(() => resource.release()).toThrow(/drain/);
    resume();
    await operation;
    await drains;
    session.release();
    resource.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('shares resource ownership independently from harness ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-shared-provider-'));
  const first = await SessionOwnership.acquire(join(dir, 'harness-a.json'));
  const second = await SessionOwnership.acquire(join(dir, 'harness-b.json'));
  const resource = await SessionOwnership.acquireProvider(join(dir, 'provider.json'));
  try {
    await expect(SessionOwnership.acquireProvider(join(dir, 'provider.json'))).rejects.toThrow(/already in use/);
    await second.closeWritesAndDrain();
    second.release();
    const retry = await SessionOwnership.acquire(join(dir, 'harness-b.json'));
    await retry.closeWritesAndDrain();
    retry.release();
  } finally {
    await Promise.all([first.closeWritesAndDrain(), resource.closeWritesAndDrain()]);
    first.release();
    resource.release();
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not reserve either side when one joint gate is already closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-joint-closed-'));
  const session = await SessionOwnership.acquire(join(dir, 'harness.json'));
  const resource = await SessionOwnership.acquireProvider(join(dir, 'provider.json'));
  try {
    await resource.closeWritesAndDrain();
    await expect(session.runJointWrite(resource, async () => {})).rejects.toThrow(/no longer accepting/);
    await session.closeWritesAndDrain();
    session.release();
    resource.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


it('rejects a store file reached through symlinks or hard links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-file-alias-'));
  const path = join(dir, 'session.json');
  try {
    await writeFile(path, '{}');
    await symlink(path, join(dir, 'alias.json'));
    await expect(SessionOwnership.acquire(join(dir, 'alias.json'))).rejects.toThrow(/symlink or hard link/);
    await link(path, join(dir, 'hard.json'));
    await expect(SessionOwnership.acquire(path)).rejects.toThrow(/symlink or hard link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
