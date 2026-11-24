import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  archiveWorkspaceMemo, archiveWorkspaceNote, assertValidSlugKey,
  createWorkspaceNote, listWorkspaceNotes, NOTE_MEMO_MAX_BYTES,
  pushWorkspaceMemo, readWorkspaceAnchor, readWorkspaceNote,
} from '@agents-ensemble/core';

class NotesUsageError extends Error {}

type Options = {
  repoRoot?: string; slug?: string; conductorCwd?: string; json?: boolean;
  summary?: string; note?: string; memo?: string; body?: string;
  offset?: string; limit?: string; includeArchived?: boolean; history?: boolean;
  archived?: string | boolean;
};

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new NotesUsageError(`${name} must be an integer.`);
  }
  return Number(value);
}

function archived(value: string | boolean | undefined): boolean {
  if (value === undefined || value === true || value === 'true') return true;
  if (value === 'false') return false;
  throw new NotesUsageError('--archived must be true or false.');
}

async function context(options: Options) {
  const cwd = resolve(options.conductorCwd ?? process.env.ENSEMBLE_WORKSPACE_CONDUCTOR_CWD ?? process.cwd());
  let slugKey = options.slug ?? process.env.ENSEMBLE_WORKSPACE_SLUG;
  try {
    slugKey ??= (await readWorkspaceAnchor(cwd))?.slug;
    if (!slugKey) throw new Error('No workspace anchor found; specify --slug or run from a workspace.');
    assertValidSlugKey(slugKey);
  } catch (error) {
    throw new NotesUsageError(error instanceof Error ? error.message : String(error));
  }
  let repoRoot = options.repoRoot ?? process.env.ENSEMBLE_WORKSPACE_REPO_ROOT;
  if (!repoRoot) {
    try {
      repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new NotesUsageError('Cannot resolve git root; specify --repo-root.');
    }
  }
  return { repoRoot: resolve(repoRoot), slugKey };
}

async function stdinBody(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function registerNotesCommand(program: Command): void {
  const notes = program.command('notes').description('Read and write workspace Notes');
  notes.exitOverride();
  function common(command: Command): Command {
    return command.option('--repo-root <path>', 'Repository root')
      .option('--slug <slug>', 'Workspace slug key')
      .option('--conductor-cwd <path>', 'Directory containing the workspace anchor')
      .option('--json', 'Output JSON');
  }
  function action(command: Command, operation: (options: Options, arg?: string) => Promise<unknown>, hasArg = false) {
    command.action(async (...args: unknown[]) => {
      const arg = hasArg ? args[0] as string : undefined;
      const options = args[hasArg ? 1 : 0] as Options;
      try {
        const result = await operation(options, arg);
        console.log(JSON.stringify(result ?? { ok: true }, null, options.json ? undefined : 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = error instanceof NotesUsageError ? 2 : 1;
      }
    });
  }
  action(common(notes.command('create').requiredOption('--summary <text>')), async (o) => {
    if (!o.summary?.trim()) throw new NotesUsageError('Note summary is required.');
    return createWorkspaceNote({ ...await context(o), summary: o.summary });
  });
  action(common(notes.command('push').requiredOption('--note <id>').option('--body <text>')), async (o) => {
    const scope = await context(o);
    const body = o.body ?? await stdinBody();
    if (!body.trim() || Buffer.byteLength(body.trim(), 'utf8') > NOTE_MEMO_MAX_BYTES) throw new NotesUsageError(`Memo body must be non-empty and at most ${NOTE_MEMO_MAX_BYTES} bytes.`);
    return pushWorkspaceMemo({ ...scope, noteId: o.note!, body });
  });
  action(common(notes.command('list').option('--offset <n>').option('--limit <n>').option('--include-archived')), async (o) => listWorkspaceNotes({ ...await context(o), offset: integer(o.offset, 'offset'), limit: integer(o.limit, 'limit'), includeArchived: o.includeArchived }));
  action(common(notes.command('show').argument('<noteId>').option('--history').option('--offset <n>').option('--limit <n>')), async (o, id) => readWorkspaceNote({ ...await context(o), noteId: id!, includeHistory: o.history, historyOffset: integer(o.offset, 'offset'), historyLimit: integer(o.limit, 'limit') }), true);
  action(common(notes.command('archive').argument('<noteId>').option('--archived [boolean]', 'Archive (true) or restore (false)')), async (o, id) => { await archiveWorkspaceNote({ ...await context(o), noteId: id!, archived: archived(o.archived) }); }, true);
  action(common(notes.command('archive-memo').requiredOption('--note <id>').requiredOption('--memo <id>').option('--archived [boolean]', 'Archive (true) or restore (false)')), async (o) => { await archiveWorkspaceMemo({ ...await context(o), noteId: o.note!, memoId: o.memo!, archived: archived(o.archived) }); });
}
