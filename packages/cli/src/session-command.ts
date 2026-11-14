import { resolve } from 'node:path';
import chalk, { Chalk } from 'chalk';
import {
  CONDUCTOR_MESSAGE_PAGE_DEFAULT_LIMIT,
  CONDUCTOR_PROVIDER_HISTORY_LIMIT,
  findSessionResumeStoreBySelector,
  getWorkerSessionHistoryReaderSupport,
  harnessPhaseFromLegacyLifecycle,
  listConductorProviderHistory,
  listLocatedSessionResumeStoresPage,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  readWorkerSessionHistory,
  sessionSnapshotPaths,
  type ConductorBackend,
  type ConductorProviderHistoryMessage,
  type HarnessPhase,
  type LocatedSessionResumeStore,
  type SessionLifecycle,
  type SessionResumeStore,
  type SessionResumeStoreLocation,
  type WorkerSessionHistoryReaderSupport,
  type WorkerSessionHistoryResult,
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
  nextCursor?: string;
}

export interface SessionShowResult {
  repoRoot: string;
  session: SessionListEntry;
  workerReaders: Array<
    WorkerSessionHistoryReaderSupport & { worker: string }
  >;
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

export type SessionWorkerMessagesResult = WorkerSessionHistoryResult;

export async function listSavedSessions(input: {
  repoRoot: string;
  githubRepo?: string;
  issueUrl?: string;
  conductorAgentId?: string;
  limit?: number;
  cursor?: string;
}): Promise<SessionListResult> {
  const repoRoot = resolve(input.repoRoot);
  const page = await listLocatedSessionResumeStoresPage(repoRoot, {
    githubRepo: input.githubRepo,
    issueUrl: input.issueUrl,
    conductorAgentId: input.conductorAgentId,
    limit: input.limit,
    cursor: input.cursor,
  });
  const sessions = page.sessions.map(({ resumeStore, location }) =>
    summarizeSession(resumeStore, location),
  );

  return {
    repoRoot,
    dataAsOf: new Date().toISOString(),
    total: page.total,
    sessions,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function showSavedSession(input: {
  repoRoot: string;
  conductorAgentId: string;
  githubRepo?: string;
  issueUrl?: string;
}): Promise<SessionShowResult> {
  const repoRoot = resolve(input.repoRoot);
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const located = await findSessionResumeStoreBySelector(repoRoot, {
    githubRepo: input.githubRepo,
    issueUrl: input.issueUrl,
    conductorAgentId,
  });
  if (!located) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

  const [openQuestions, sessionState] = await Promise.all([
    loadOpenQuestionsSummary(repoRoot, located),
    loadSessionStateSummary(repoRoot, located),
  ]);
  const workerReaders = Object.entries(located.resumeStore.workers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([worker, workerResumeStore]) => ({
      worker,
      ...getWorkerSessionHistoryReaderSupport(
        workerResumeStore.acpSpawn?.preset,
      ),
    }));

  return {
    repoRoot,
    session: summarizeSession(located.resumeStore, located.location),
    workerReaders,
    paths: {
      sessionResumeStore: located.path,
    },
    relatedData: {
      openQuestions,
      sessionState,
    },
  };
}

export async function readSavedSessionWorkerMessages(input: {
  repoRoot: string;
  conductorAgentId: string;
  workerName: string;
  githubRepo?: string;
  issueUrl?: string;
}): Promise<SessionWorkerMessagesResult> {
  return readWorkerSessionHistory({
    repoRoot: input.repoRoot,
    conductorAgentId: input.conductorAgentId,
    workerName: input.workerName,
    githubRepo: input.githubRepo,
    issueUrl: input.issueUrl,
  });
}

export async function listSavedSessionMessages(input: {
  repoRoot: string;
  conductorAgentId: string;
  githubRepo?: string;
  issueUrl?: string;
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

  const located = await findSessionResumeStoreBySelector(repoRoot, {
    githubRepo: input.githubRepo,
    issueUrl: input.issueUrl,
    conductorAgentId,
  });
  if (!located) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

  const resumeStore = located.resumeStore;
  const backend = resumeStore.conductorBackend ?? 'cursor';
  const history = await listConductorProviderHistory({
    backend,
    conductorAgentId,
    cwd: resumeStore.conductorCwd ?? resumeStore.repoRoot,
    repoRoot,
    issueUrl: resumeStore.issueUrl,
    ...(backend === 'pi'
      ? {
          fallbackCwds: [
            resumeStore.conductorCwd,
            resumeStore.repoRoot,
          ].filter((cwd): cwd is string => Boolean(cwd)),
          fallbackRepoRoots: [resumeStore.repoRoot],
        }
      : {}),
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
  const text = result.sessions
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
  return result.nextCursor
    ? `${text}\n\n次のページ: --cursor ${result.nextCursor}`
    : text;
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
    formatWorkerReaders(result.workerReaders),
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

export function formatSessionWorkerMessagesText(
  result: SessionWorkerMessagesResult,
): string {
  const color = outputChalk();
  const title = `${result.conductorAgentId} / ${result.worker} (${
    result.preset ?? 'preset不明'
  })`;
  if (result.status !== 'supported') {
    return [
      `${color.bold(title)} — ${formatWorkerHistoryStatus(result.status)}`,
      ...(result.reason ? [`理由: ${result.reason}`] : []),
    ].join('\n');
  }
  if (result.messages.length === 0) {
    return `${color.bold(title)}: 表示できる会話履歴はありません。`;
  }

  const lines = [
    `${color.bold(title)} (${result.reader ?? 'reader不明'})`,
  ];
  for (const message of result.messages) {
    lines.push(
      '',
      `${color.dim(
        message.at === undefined ? '時刻不明' : formatTimestamp(message.at),
      )}  ${message.role}  providerId: ${message.providerId}`,
      ...indentLines(message.text),
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

function formatWorkerReaders(
  workers: SessionShowResult['workerReaders'],
): string {
  if (workers.length === 0) return 'workers: なし';
  const color = outputChalk();
  return [
    'workers:',
    ...workers.map((worker) => {
      const preset = worker.preset ?? 'preset不明';
      const status =
        worker.status === 'supported'
          ? `読取対応 (${worker.reader})`
          : `未対応: ${worker.reason}`;
      return `  ${color.bold(worker.worker)} (${preset}): ${status}`;
    }),
  ].join('\n');
}

function formatWorkerHistoryStatus(
  status: SessionWorkerMessagesResult['status'],
): string {
  switch (status) {
    case 'unsupported':
      return '履歴読取は未対応です';
    case 'unavailable':
      return '履歴を利用できません';
    case 'supported':
      return '履歴読取に対応しています';
  }
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
