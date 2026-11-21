import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import {
  archiveWorkspaceMemo,
  archiveWorkspaceNote,
  createWorkspaceNote,
  listWorkspaceNotes,
  pushWorkspaceMemo,
  readWorkspaceNote,
} from './workspace-notes-store.js';

export interface WorkspaceNotesToolsOptions {
  repoRoot: string;
  slugKey: string;
}

export function createWorkspaceNotesTools(
  options: WorkspaceNotesToolsOptions,
): ConductorToolSet {
  const ctx = { repoRoot: options.repoRoot, slugKey: options.slugKey };
  return {
    create_note: {
      name: 'create_note',
      description:
        'Create a workspace note with a required short summary (title).',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Short note title / summary' },
        },
        required: ['summary'],
      },
      async execute(args) {
        const note = await createWorkspaceNote({
          ...ctx,
          summary: String(args.summary ?? ''),
        });
        return textResult({ noteId: note.id, summary: note.summary });
      },
    },
    push_memo: {
      name: 'push_memo',
      description: 'Append a memo to a note (append-only history).',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['noteId', 'body'],
      },
      async execute(args) {
        const memo = await pushWorkspaceMemo({
          ...ctx,
          noteId: String(args.noteId ?? ''),
          body: String(args.body ?? ''),
        });
        return textResult({ memoId: memo.id, noteId: String(args.noteId) });
      },
    },
    list_notes: {
      name: 'list_notes',
      description:
        'List notes with summary and latest memo preview. Archived notes omitted by default.',
      inputSchema: {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean' },
          offset: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      async execute(args) {
        const page = await listWorkspaceNotes({
          ...ctx,
          includeArchived: args.includeArchived === true,
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        });
        return textResult(page);
      },
    },
    read_note: {
      name: 'read_note',
      description:
        'Read a note. Default: latest non-archived memo only; set includeHistory for paging.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string' },
          includeHistory: { type: 'boolean' },
          historyOffset: { type: 'number' },
          historyLimit: { type: 'number' },
          includeArchived: { type: 'boolean' },
        },
        required: ['noteId'],
      },
      async execute(args) {
        const payload = await readWorkspaceNote({
          ...ctx,
          noteId: String(args.noteId ?? ''),
          includeHistory: args.includeHistory === true,
          includeArchived: args.includeArchived === true,
          ...(typeof args.historyOffset === 'number'
            ? { historyOffset: args.historyOffset }
            : {}),
          ...(typeof args.historyLimit === 'number'
            ? { historyLimit: args.historyLimit }
            : {}),
        });
        return textResult(payload);
      },
    },
    archive_note: {
      name: 'archive_note',
      description: 'Archive or unarchive a note (hidden from default list).',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string' },
          archived: { type: 'boolean' },
        },
        required: ['noteId', 'archived'],
      },
      async execute(args) {
        await archiveWorkspaceNote({
          ...ctx,
          noteId: String(args.noteId ?? ''),
          archived: args.archived === true,
        });
        return textResult({ ok: true });
      },
    },
    archive_memo: {
      name: 'archive_memo',
      description: 'Archive or unarchive a single memo.',
      inputSchema: {
        type: 'object',
        properties: {
          noteId: { type: 'string' },
          memoId: { type: 'string' },
          archived: { type: 'boolean' },
        },
        required: ['noteId', 'memoId', 'archived'],
      },
      async execute(args) {
        await archiveWorkspaceMemo({
          ...ctx,
          noteId: String(args.noteId ?? ''),
          memoId: String(args.memoId ?? ''),
          archived: args.archived === true,
        });
        return textResult({ ok: true });
      },
    },
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}
