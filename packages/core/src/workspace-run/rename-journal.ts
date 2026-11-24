import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseSessionResumeStore, WORKSPACE_RENAME_SESSION_RESUME_STORE_VERSION } from '../session/session-resume-store.js';
import { assertValidSlugKey, workspaceAnchorPath } from './slug-key.js';

interface Entry { name: string; before: string; after: string }
interface Journal { version: 1; from: string; to: string; cwd: string; anchorBefore: string | null; anchorAfter: string; stores: Entry[] }
interface JournalEnvelope { journal: Journal; sha256: string }

export function renameJournalPath(userRoot: string): string {
  return join(userRoot, 'session-locks', 'workspace-rename.json');
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function assertNoRenameJournal(userRoot: string): Promise<void> {
  try { await lstat(renameJournalPath(userRoot)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('A workspace rename needs recovery. Stop all sessions and run ensemble workspace-rename-recover.');
}

// Write contents before publishing the directory entry. This protects against
// process termination; durability across power loss depends on the filesystem.
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(data, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

const rootKeys = new Set(['version', 'conductorAgentId', 'conductorBackend', 'createdHarnessCliVersion', 'conductorCwd', 'cursorBootstrapRunId', 'cursorBootstrapComplete', 'lazyWorkers', 'harnessSocketPath', 'issueUrl', 'repoRoot', 'profile', 'profilePath', 'openQuestions', 'sequence', 'workers', 'githubMonitor', 'mcpConfigDigest', 'ensembleConfigDigestScheme', 'ensembleConfigDigest', 'acpModelConfigDigest', 'lifecycle', 'harnessPhase', 'modifiedAt', 'updatedAt']);
const workerKeys = new Set(['acpSessionId', 'acpCwd', 'acpSpawn', 'originAcpCwd', 'originAcpSpawn', 'repoRoot', 'issueUrl', 'handoffPending', 'recreateRequired', 'generations']);
const generationKeys = new Set(['acpSessionId', 'acpCwd', 'acpSpawn', 'repoRoot', 'issueUrl', 'replacedAt', 'reason', 'nextSessionId']);
const spawnKeys = new Set(['preset', 'command', 'args', 'piRuntime', 'envDigest', 'modelTag', 'model', 'reasoning', 'cursorFast', 'modelProviderDigest']);
function checkKeys(value: Record<string, unknown>, allowed: Set<string>, description: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${description} field "${key}"; rename refused.`);
}

function migratedStore(before: string, name: string, from: string, to: string): string {
  const value: unknown = JSON.parse(before);
  const parsed = parseSessionResumeStore(value);
  if (parsed.issueUrl !== `workspace://${from}` || name !== `${parsed.conductorAgentId}.json` || basename(parsed.conductorAgentId) !== parsed.conductorAgentId) {
    throw new Error(`Session identity does not match workspace: ${name}`);
  }
  const raw = value as Record<string, unknown>;
  checkKeys(raw, rootKeys, 'session store');
  const workers = raw.workers as Record<string, Record<string, unknown>>;
  for (const worker of Object.values(workers)) {
    checkKeys(worker, workerKeys, 'worker');
    if (typeof worker.acpSessionId !== 'string' || !worker.acpSessionId.trim()) {
      throw new Error(`Session ${name} has an invalid worker session ID.`);
    }
    for (const key of ['repoRoot', 'issueUrl', 'acpCwd', 'originAcpCwd'] as const) {
      if (worker[key] !== undefined && (typeof worker[key] !== 'string' || !worker[key].trim())) {
        throw new Error(`Session ${name} has an invalid worker ${key}.`);
      }
    }
    for (const key of ['acpSpawn', 'originAcpSpawn'] as const) {
      const spawn = worker[key];
      if (spawn && typeof spawn === 'object') checkKeys(spawn as Record<string, unknown>, spawnKeys, 'ACP spawn');
    }
    for (const generation of (worker.generations as Record<string, unknown>[] | undefined) ?? []) {
      checkKeys(generation, generationKeys, 'worker generation');
      if (generation.acpSpawn && typeof generation.acpSpawn === 'object') checkKeys(generation.acpSpawn as Record<string, unknown>, spawnKeys, 'ACP spawn');
    }
    if (worker.handoffPending === true) throw new Error(`Session ${name} has a pending worker handoff; finish it before rename.`);
    worker.repoRoot ??= raw.repoRoot;
    worker.issueUrl ??= raw.issueUrl;
    worker.recreateRequired = true;
  }
  raw.version = WORKSPACE_RENAME_SESSION_RESUME_STORE_VERSION;
  raw.issueUrl = `workspace://${to}`;
  const after = `${JSON.stringify(raw, null, 2)}\n`;
  const migrated = parseSessionResumeStore(JSON.parse(after));
  if (migrated.issueUrl !== `workspace://${to}` || migrated.conductorAgentId !== parsed.conductorAgentId) throw new Error(`Invalid migrated session identity: ${name}`);
  return after;
}

export async function prepareRenameJournal(input: { userRoot: string; cwd: string; from: string; to: string }): Promise<Journal> {
  await assertNoRenameJournal(input.userRoot);
  const source = join(input.userRoot, 'workspaces', input.from);
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace source must be a directory, not a symbolic link.');
  const stores: Entry[] = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) throw new Error(`Unsupported workspace session store: ${entry.name}`);
    const before = await readFile(join(source, entry.name), 'utf8');
    let after: string;
    try {
      after = migratedStore(before, entry.name, input.from, input.to);
    } catch (error) {
      throw new Error(`Invalid session resume store: ${entry.name}: ${String(error)}`, { cause: error });
    }
    stores.push({ name: entry.name, before, after });
  }
  const anchorPath = workspaceAnchorPath(input.cwd);
  const anchorInfo = await lstat(anchorPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (anchorInfo && (!anchorInfo.isFile() || anchorInfo.isSymbolicLink())) throw new Error('Workspace anchor must be a regular file.');
  const anchorBefore = await readOptional(anchorPath);
  if (anchorBefore !== null) {
    const value = JSON.parse(anchorBefore) as Record<string, unknown>;
    if (!value || Object.keys(value).some((key) => key !== 'slug') || value.slug !== input.from) throw new Error('Workspace anchor is unknown or does not match the source.');
  }
  return { version: 1, from: input.from, to: input.to, cwd: resolve(input.cwd), anchorBefore, anchorAfter: `${JSON.stringify({ slug: input.to }, null, 2)}\n`, stores };
}

export async function publishRenameJournal(userRoot: string, journal: Journal): Promise<void> {
  const serialized = JSON.stringify(journal);
  const envelope: JournalEnvelope = { journal, sha256: createHash('sha256').update(serialized).digest('hex') };
  await atomicWrite(renameJournalPath(userRoot), `${JSON.stringify(envelope)}\n`);
}

export async function applyRenameJournal(userRoot: string, journal: Journal): Promise<void> {
  const source = join(userRoot, 'workspaces', journal.from);
  const target = join(userRoot, 'workspaces', journal.to);
  for (const entry of journal.stores) await atomicWrite(join(source, entry.name), entry.after);
  await rename(source, target);
  await atomicWrite(workspaceAnchorPath(journal.cwd), journal.anchorAfter);
  await rm(renameJournalPath(userRoot));
}

export async function rollbackRenameJournal(userRoot: string): Promise<void> {
  const path = renameJournalPath(userRoot);
  const raw = await readFile(path, 'utf8');
  const envelope = JSON.parse(raw) as JournalEnvelope;
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'journal,sha256' ||
      typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.sha256) ||
      createHash('sha256').update(JSON.stringify(envelope.journal) ?? '').digest('hex') !== envelope.sha256) {
    throw new Error('Rename journal integrity check failed; manual inspection required.');
  }
  const journal = envelope.journal;
  if (!journal || journal.version !== 1 || typeof journal.from !== 'string' || typeof journal.to !== 'string' || typeof journal.cwd !== 'string' || !isAbsolute(journal.cwd) || !Array.isArray(journal.stores) || (journal.anchorBefore !== null && typeof journal.anchorBefore !== 'string') || typeof journal.anchorAfter !== 'string') throw new Error('Invalid rename journal; manual inspection required.');
  assertValidSlugKey(journal.from); assertValidSlugKey(journal.to);
  if (journal.from === journal.to || journal.anchorAfter !== `${JSON.stringify({ slug: journal.to }, null, 2)}\n`) throw new Error('Invalid rename journal identity.');
  if (Object.keys(journal).sort().join(',') !== 'anchorAfter,anchorBefore,cwd,from,stores,to,version') throw new Error('Invalid rename journal fields.');
  if (journal.anchorBefore !== null) {
    const anchorBefore: unknown = JSON.parse(journal.anchorBefore);
    if (!anchorBefore || typeof anchorBefore !== 'object' || Array.isArray(anchorBefore) ||
        Object.keys(anchorBefore).join(',') !== 'slug' || (anchorBefore as { slug?: unknown }).slug !== journal.from) {
      throw new Error('Invalid rename journal anchor snapshot.');
    }
  }
  const names = new Set<string>();
  for (const entry of journal.stores) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'after,before,name' ||
        typeof entry.name !== 'string' || basename(entry.name) !== entry.name || !entry.name.endsWith('.json') ||
        names.has(entry.name) || typeof entry.before !== 'string' || typeof entry.after !== 'string') {
      throw new Error('Invalid rename journal store entry.');
    }
    names.add(entry.name);
    if (migratedStore(entry.before, entry.name, journal.from, journal.to) !== entry.after) {
      throw new Error(`Invalid rename journal migration snapshots: ${entry.name}`);
    }
  }
  const source = join(userRoot, 'workspaces', journal.from);
  const target = join(userRoot, 'workspaces', journal.to);
  const sourceInfo = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!!sourceInfo === !!targetInfo || (sourceInfo ?? targetInfo)?.isSymbolicLink() || !(sourceInfo ?? targetInfo)?.isDirectory()) throw new Error('Workspace paths changed; automatic recovery refused.');
  const current = sourceInfo ? source : target;
  const seen = new Set<string>();
  for (const entry of journal.stores) {
    if (!entry || typeof entry.name !== 'string' || basename(entry.name) !== entry.name || !entry.name.endsWith('.json') || seen.has(entry.name) || typeof entry.before !== 'string' || typeof entry.after !== 'string') throw new Error('Invalid rename journal store entry.');
    seen.add(entry.name);
    const file = join(current, entry.name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Session store changed: ${entry.name}`);
    const value = await readFile(file, 'utf8');
    if (value !== entry.before && value !== entry.after) throw new Error(`Session store changed: ${entry.name}; automatic recovery refused.`);
  }
  const actualStores = (await readdir(current)).filter((name) => name.endsWith('.json'));
  if (actualStores.length !== seen.size || actualStores.some((name) => !seen.has(name))) {
    throw new Error('Workspace session store inventory changed; automatic recovery refused.');
  }
  const anchor = workspaceAnchorPath(journal.cwd);
  const anchorInfo = await lstat(anchor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (anchorInfo && (!anchorInfo.isFile() || anchorInfo.isSymbolicLink())) throw new Error('Workspace anchor changed; automatic recovery refused.');
  const currentAnchor = await readOptional(anchor);
  if (currentAnchor !== journal.anchorBefore && currentAnchor !== journal.anchorAfter) throw new Error('Workspace anchor changed; automatic recovery refused.');
  for (const entry of journal.stores) {
    if (await readFile(join(current, entry.name), 'utf8') !== entry.before) {
      await atomicWrite(join(current, entry.name), entry.before);
    }
  }
  if (current === target) await rename(target, source);
  if (currentAnchor !== journal.anchorBefore) {
    if (journal.anchorBefore === null) await rm(anchor, { force: true });
    else await atomicWrite(anchor, journal.anchorBefore);
  }
  await rm(path);
}
