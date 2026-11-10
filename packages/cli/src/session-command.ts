import { resolve } from 'node:path';
import chalk, { Chalk } from 'chalk';
import {
  CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT,
  CONDUCTOR_PROVIDER_HISTORY_LIMIT,
  findSessionResumeStore,
  harnessPhaseFromLegacyLifecycle,
  listConductorProviderHistory,
  listLocatedSessionResumeStores,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  parseIssueUrl,
  sessionSnapshotPaths,
  type ConductorBackend,
  type ConductorProviderHistoryMessage,
  type HarnessPhase,
  type LocatedSessionResumeStore,
  type SessionLifecycle,
  type SessionResumeStore,
  type SessionResumeStoreLocation,
} from '@agents-ensemble/core/operator-runtime';

export interface SessionListEntry {
  conductorAgentId: string;
  issueUrl: string;
  conductorBackend: ConductorBackend;
  updatedAt: number;
  lifecycle: SessionLifecycle;
  harnessPhase: HarnessPhase | null;
  workers: string[];
  location: SessionResumeStoreLocation;
}

export interface SessionListResult {
  repoRoot: string;
  dataAsOf: string;
  total: number;
  sessions: SessionListEntry[];
}

export interface SessionShowResult {
  repoRoot: string;
  session: SessionListEntry;
  paths: {
    sessionResumeStore: string;
  };
  relatedData: {
    openQuestions: {
      path: string;
      found: boolean;
      summary: {
        sequence: number;
        total: number;
        open: number;
        answered: number;
      } | null;
    };
    sessionState: {
      path: string;
      found: boolean;
      summary: {
        currentReportedAt: number;
        historyCount: number;
      } | null;
    };
  };
}

export interface SessionMessagesResult {
  conductorAgentId: string;
  backend: ConductorBackend;
  messages: ConductorProviderHistoryMessage[];
  hasMore: boolean;
}

export async function listSavedSessions(input: {
  repoRoot: string;
  issueUrl?: string;
}): Promise<SessionListResult> {
  const repoRoot = resolve(input.repoRoot);
  const issueFilter = input.issueUrl ? issueKey(input.issueUrl) : undefined;
  const locatedStores = await listLocatedSessionResumeStores(repoRoot);
  const sessions = locatedStores
    .filter(({ resumeStore }) => resolve(resumeStore.repoRoot) === repoRoot)
    .filter(
      ({ resumeStore }) =>
        issueFilter === undefined ||
        issueKeyOrUndefined(resumeStore.issueUrl) === issueFilter,
    )
    .map(({ resumeStore, location }) =>
      summarizeSession(resumeStore, location),
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.conductorAgentId.localeCompare(right.conductorAgentId),
    );

  return {
    repoRoot,
    dataAsOf: new Date().toISOString(),
    total: sessions.length,
    sessions,
  };
}

export async function showSavedSession(input: {
  repoRoot: string;
  conductorAgentId: string;
}): Promise<SessionShowResult> {
  const repoRoot = resolve(input.repoRoot);
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const located = await findSessionResumeStore(repoRoot, conductorAgentId);
  if (
    !located ||
    resolve(located.resumeStore.repoRoot) !== repoRoot
  ) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

  const [openQuestions, sessionState] = await Promise.all([
    loadOpenQuestionsSummary(repoRoot, located),
    loadSessionStateSummary(repoRoot, located),
  ]);

  return {
    repoRoot,
    session: summarizeSession(located.resumeStore, located.location),
    paths: {
      sessionResumeStore: located.path,
    },
    relatedData: {
      openQuestions,
      sessionState,
    },
  };
}

export async function listSavedSessionMessages(input: {
  repoRoot: string;
  conductorAgentId: string;
  limit?: number;
  order?: 'asc' | 'desc';
  cursor?: string;
}): Promise<SessionMessagesResult> {
  const repoRoot = resolve(input.repoRoot);
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const limit = input.limit ?? CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONDUCTOR_PROVIDER_HISTORY_LIMIT
  ) {
    throw new Error(
      `limit must be an integer between 1 and ${CONDUCTOR_PROVIDER_HISTORY_LIMIT}.`,
    );
  }
  const order = input.order ?? 'desc';
  if (order !== 'asc' && order !== 'desc') {
    throw new Error('order must be asc or desc.');
  }
  const cursor =
    input.cursor === undefined
      ? undefined
      : requireNonEmpty(input.cursor, 'cursor');

  const located = await findSessionResumeStore(repoRoot, conductorAgentId);
  if (
    !located ||
    resolve(located.resumeStore.repoRoot) !== repoRoot
  ) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

  const resumeStore = located.resumeStore;
  const backend = resumeStore.conductorBackend ?? 'cursor';
  const history = await listConductorProviderHistory({
    backend,
    conductorAgentId,
    cwd: resumeStore.conductorCwd ?? resumeStore.repoRoot,
    ...(resumeStore.cursorBootstrapRunId
      ? { cursorBootstrapRunId: resumeStore.cursorBootstrapRunId }
      : {}),
    query: {
      limit,
      order,
      ...(cursor ? { cursor } : {}),
    },
  });

  return {
    conductorAgentId,
    backend,
    ...history,
  };
}

export function formatSessionListText(result: SessionListResult): string {
  if (result.sessions.length === 0) {
    return '保存済み session はありません。';
  }

  const color = outputChalk();
  return result.sessions
    .map((session) =>
      [
        `${color.bold(session.conductorAgentId)} (${color.cyan(session.conductorBackend)})`,
        `  Issue: ${session.issueUrl}`,
        `  更新: ${formatTimestamp(session.updatedAt)}`,
        `  状態: ${session.harnessPhase ?? session.lifecycle}`,
        `  workers: ${
          session.workers.length > 0 ? session.workers.join(', ') : 'なし'
        }`,
      ].join('\n'),
    )
    .join('\n\n');
}

export function formatSessionShowText(result: SessionShowResult): string {
  const color = outputChalk();
  const session = result.session;
  const questions = result.relatedData.openQuestions;
  const state = result.relatedData.sessionState;
  return [
    `${color.bold(session.conductorAgentId)} (${color.cyan(session.conductorBackend)})`,
    `Issue: ${session.issueUrl}`,
    `更新: ${formatTimestamp(session.updatedAt)}`,
    `状態: ${session.harnessPhase ?? session.lifecycle}`,
    `workers: ${
      session.workers.length > 0 ? session.workers.join(', ') : 'なし'
    }`,
    `SessionResumeStore: ${result.paths.sessionResumeStore}`,
    formatOpenQuestionsSummary(questions),
    formatSessionStateSummary(state),
  ].join('\n');
}

export function formatSessionMessagesText(
  result: SessionMessagesResult,
): string {
  if (result.messages.length === 0) {
    return `${result.conductorAgentId} (${result.backend}): 表示できる会話履歴はありません。`;
  }

  const color = outputChalk();
  const lines = [
    `${color.bold(result.conductorAgentId)} (${color.cyan(result.backend)})`,
  ];
  for (const message of result.messages) {
    lines.push(
      '',
      `${color.dim(formatTimestamp(message.at))}  providerId: ${
        message.providerId
      }`,
      '  operator → conductor:',
      ...indentLines(message.inbound),
      '  conductor → operator:',
      ...indentLines(message.text),
    );
  }
  if (result.hasMore) {
    lines.push(
      '',
      'さらに古い履歴があります。表示した providerId を --cursor に指定してください。',
    );
  }
  return lines.join('\n');
}

function summarizeSession(
  resumeStore: SessionResumeStore,
  location: SessionResumeStoreLocation,
): SessionListEntry {
  const lifecycle = resumeStore.lifecycle ?? 'unknown';
  return {
    conductorAgentId: resumeStore.conductorAgentId,
    issueUrl: resumeStore.issueUrl,
    conductorBackend: resumeStore.conductorBackend ?? 'cursor',
    updatedAt: resumeStore.updatedAt,
    lifecycle,
    harnessPhase:
      resumeStore.harnessPhase ??
      harnessPhaseFromLegacyLifecycle(lifecycle),
    workers: Object.keys(resumeStore.workers).sort(),
    location,
  };
}

async function loadOpenQuestionsSummary(
  repoRoot: string,
  located: LocatedSessionResumeStore,
): Promise<SessionShowResult['relatedData']['openQuestions']> {
  const paths = sessionSnapshotPaths(repoRoot, located, 'open-questions');
  for (const path of paths) {
    const snapshot = await loadOpenQuestionsStore(path);
    if (!snapshot) continue;
    const open = snapshot.openQuestions.filter(
      (question) => question.status === 'open',
    ).length;
    return {
      path,
      found: true,
      summary: {
        sequence: snapshot.sequence,
        total: snapshot.openQuestions.length,
        open,
        answered: snapshot.openQuestions.length - open,
      },
    };
  }
  return {
    path: paths[0]!,
    found: false,
    summary: null,
  };
}

async function loadSessionStateSummary(
  repoRoot: string,
  located: LocatedSessionResumeStore,
): Promise<SessionShowResult['relatedData']['sessionState']> {
  const paths = sessionSnapshotPaths(repoRoot, located, 'session-state');
  for (const path of paths) {
    const state = await loadSessionStateStore(path);
    if (!state) continue;
    return {
      path,
      found: true,
      summary: {
        currentReportedAt: state.current.reportedAt,
        historyCount: state.history.length,
      },
    };
  }
  return {
    path: paths[0]!,
    found: false,
    summary: null,
  };
}

function issueKey(issueUrl: string): string {
  const issue = parseIssueUrl(issueUrl);
  return `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`;
}

function issueKeyOrUndefined(issueUrl: string): string | undefined {
  try {
    return issueKey(issueUrl);
  } catch {
    return undefined;
  }
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return normalized;
}

function formatOpenQuestionsSummary(
  data: SessionShowResult['relatedData']['openQuestions'],
): string {
  if (!data.found || !data.summary) {
    return `open-questions: なし (${data.path})`;
  }
  return `open-questions: ${data.summary.open} 件 open / ${
    data.summary.total
  } 件 (${data.path})`;
}

function formatSessionStateSummary(
  data: SessionShowResult['relatedData']['sessionState'],
): string {
  if (!data.found || !data.summary) {
    return `session-state: なし (${data.path})`;
  }
  return `session-state: ${formatTimestamp(
    data.summary.currentReportedAt,
  )}、過去 ${data.summary.historyCount} 件 (${data.path})`;
}

function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return '時刻不明';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function indentLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => `    ${line}`);
}

function outputChalk() {
  return new Chalk({
    level: process.env.NO_COLOR ? 0 : chalk.level,
  });
}
