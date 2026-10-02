import type { EnsembleConfig } from '../config/types.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import type { GitHubClient } from './github-client.js';
import { createGitHubClient } from './github-client.js';
import {
  DEFAULT_GITHUB_WATCH_KINDS,
  normalizeGitHubMonitorCursor,
  type ExplicitPullRequestWatch,
  type GitHubMonitorCursor,
  type PullRequestMonitorCursor,
} from './github-monitor-cursor.js';
import {
  createGitHubMonitorPhaseError,
  safeUpperString,
  type GitHubMonitorPhaseError,
} from './github-monitor-error.js';
import type {
  GitHubCiAggregateState,
  GitHubUpdateItem,
  GitHubUpdateKind,
} from './github-update-types.js';

const BODY_PREVIEW_MAX = 280;

export interface FetchGitHubUpdatesInput {
  issueUrl: string;
  cursor: GitHubMonitorCursor;
  /** true のときカーソルのみ進め、更新は返さない（カーソル空の新規セッション初回 poll のみ）。 */
  initialCursorPoll?: boolean;
  ensembleConfig: EnsembleConfig;
  githubClient?: GitHubClient;
  abortSignal?: AbortSignal;
}

export interface FetchGitHubUpdatesResult {
  updates: GitHubUpdateItem[];
  cursor: GitHubMonitorCursor;
  /** いずれかの PR で CI が pending。poll 間隔短縮の判断材料。 */
  hasPendingCi: boolean;
  /** フェーズ単位で捕捉したエラー（poll 全体は継続）。 */
  errors: GitHubMonitorPhaseError[];
}

interface GhIssueComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  created_at: string;
}

interface GhPullRequestRef {
  number: number;
  title: string;
  url: string;
  state: string;
}

interface GhReview {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  state: string;
  submitted_at: string;
}

interface GhReviewComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  path: string;
  created_at: string;
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion?: string | null;
  detailsUrl?: string;
  /** head commit SHA（GraphQL レスポンスに含まれる場合）。 */
  headSha?: string;
}

/** statusCheckRollup の各 check を集約前に揃える内部 4 値。 */
type NormalizedCiCheckState = 'skip' | 'running' | 'failed' | 'complete';

interface NormalizedCiCheck {
  name: string;
  headSha: string;
  state: NormalizedCiCheckState;
  detailsUrl?: string;
}

export async function fetchGitHubUpdates(
  input: FetchGitHubUpdatesInput,
): Promise<FetchGitHubUpdatesResult> {
  const client =
    input.githubClient ??
    (await createGitHubClient({
      config: input.ensembleConfig,
      signal: input.abortSignal,
    }));
  const issue = parseIssueUrl(input.issueUrl);
  const cursor = normalizeGitHubMonitorCursor(input.cursor);
  const updates: GitHubUpdateItem[] = [];
  const errors: GitHubMonitorPhaseError[] = [];
  let hasPendingCi = false;

  try {
    const issueComments = await client.listIssueComments(
      issue.owner,
      issue.repo,
      issue.number,
    );
    const { updates: commentUpdates, lastId } = collectIssueCommentUpdates(
      issueComments,
      cursor.lastIssueCommentId,
      input.initialCursorPoll ?? false,
    );
    updates.push(...commentUpdates);
    if (lastId !== undefined) {
      cursor.lastIssueCommentId = lastId;
    }
  } catch (error) {
    errors.push(createGitHubMonitorPhaseError('issue_comments', error));
  }

  let linkedPullRequests: GhPullRequestRef[];
  try {
    linkedPullRequests = await client.searchLinkedPullRequests(
      issue.owner,
      issue.repo,
      issue.number,
    );
  } catch (error) {
    errors.push(createGitHubMonitorPhaseError('pr_search', error));
    linkedPullRequests = [];
  }
  if (!cursor.pullRequests) {
    cursor.pullRequests = {};
  }

  const explicitPullRequests = new Map<number, ExplicitPullRequestWatch>();
  for (const [key, watch] of Object.entries(cursor.explicitPullRequests ?? {})) {
    const prNumber = parsePullRequestNumberKey(key);
    if (prNumber !== undefined) {
      explicitPullRequests.set(prNumber, watch);
    }
  }

  const pullRequestsByNumber = new Map<number, GhPullRequestRef>();
  for (const pr of linkedPullRequests) {
    pullRequestsByNumber.set(pr.number, pr);
  }
  for (const prNumber of explicitPullRequests.keys()) {
    if (!pullRequestsByNumber.has(prNumber)) {
      pullRequestsByNumber.set(prNumber, {
        number: prNumber,
        title: '',
        url: `https://github.com/${issue.owner}/${issue.repo}/pull/${prNumber}`,
        state: 'OPEN',
      });
    }
  }

  const pullRequests = [...pullRequestsByNumber.values()];
  for (const pr of pullRequests) {
    const prKey = String(pr.number);
    const prCursor = cursor.pullRequests[prKey] ?? {};
    const explicitWatch = explicitPullRequests.get(pr.number);
    const hasPullRequestCursor = Object.prototype.hasOwnProperty.call(
      cursor.pullRequests,
      prKey,
    );
    const isNewPullRequest = !hasPullRequestCursor;
    const isNewExplicitPullRequest =
      explicitWatch !== undefined && isNewPullRequest;
    const prResult = await fetchPullRequestUpdates({
      client,
      issue,
      pr,
      prCursor,
      initialCursorPoll:
        (input.initialCursorPoll ?? false) || isNewExplicitPullRequest,
      ciBootstrapPoll:
        (input.initialCursorPoll ?? false) ||
        isNewPullRequest ||
        prCursor.ciBootstrapPending === true,
      watchKinds: resolveWatchKinds(explicitWatch?.kinds),
    });
    updates.push(...prResult.updates);
    cursor.pullRequests[prKey] = prResult.cursor;
    errors.push(...prResult.errors);
    if (prResult.hasPendingCi) {
      hasPendingCi = true;
    }
  }

  return { updates, cursor, hasPendingCi, errors };
}

function collectIssueCommentUpdates(
  comments: GhIssueComment[],
  lastSeenId: string | undefined,
  initialCursorPoll: boolean,
): { updates: GitHubUpdateItem[]; lastId?: string } {
  if (comments.length === 0) {
    return { updates: [], lastId: lastSeenId };
  }

  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const lastNumeric = lastSeenId ? Number.parseInt(lastSeenId, 10) : undefined;
  const newComments =
    lastNumeric === undefined
      ? sorted
      : sorted.filter((comment) => comment.id > lastNumeric);

  const lastId = String(sorted[sorted.length - 1]!.id);
  if (initialCursorPoll || newComments.length === 0) {
    return { updates: [], lastId };
  }

  return {
    updates: newComments.map((comment) => ({
      id: `issue-comment:${comment.id}`,
      kind: 'issue.comment' as const,
      summary: `Issue コメント（@${comment.user.login}）`,
      url: comment.html_url,
      author: comment.user.login,
      bodyPreview: previewBody(comment.body),
    })),
    lastId,
  };
}

async function fetchPullRequestUpdates(input: {
  client: GitHubClient;
  issue: ReturnType<typeof parseIssueUrl>;
  pr: GhPullRequestRef;
  prCursor: PullRequestMonitorCursor;
  initialCursorPoll: boolean;
  ciBootstrapPoll: boolean;
  watchKinds: GitHubUpdateKind[];
}): Promise<{
  updates: GitHubUpdateItem[];
  cursor: PullRequestMonitorCursor;
  hasPendingCi: boolean;
  errors: GitHubMonitorPhaseError[];
}> {
  const updates: GitHubUpdateItem[] = [];
  const errors: GitHubMonitorPhaseError[] = [];
  const cursor: PullRequestMonitorCursor = {
    lastReviewId: input.prCursor.lastReviewId,
    lastReviewCommentId: input.prCursor.lastReviewCommentId,
    ...(input.prCursor.lastAggregateBySha
      ? { lastAggregateBySha: cloneAggregateStates(input.prCursor.lastAggregateBySha) }
      : {}),
    ...(input.prCursor.ciBootstrapPending
      ? { ciBootstrapPending: true }
      : {}),
  };
  let hasPendingCi = false;

  if (input.watchKinds.includes('pr.review')) {
    try {
      const reviews = await input.client.listPullRequestReviews(
        input.issue.owner,
        input.issue.repo,
        input.pr.number,
      );
      const reviewResult = collectReviewUpdates(
        reviews,
        cursor.lastReviewId,
        input.initialCursorPoll,
        input.pr.number,
      );
      updates.push(...reviewResult.updates);
      if (reviewResult.lastId !== undefined) {
        cursor.lastReviewId = reviewResult.lastId;
      }
    } catch (error) {
      errors.push(
        createGitHubMonitorPhaseError('pr_reviews', error, input.pr.number),
      );
    }
  }

  if (input.watchKinds.includes('pr.review_comment')) {
    try {
      const reviewComments = await input.client.listPullRequestReviewComments(
        input.issue.owner,
        input.issue.repo,
        input.pr.number,
      );
      const reviewCommentResult = collectReviewCommentUpdates(
        reviewComments,
        cursor.lastReviewCommentId,
        input.initialCursorPoll,
        input.pr.number,
      );
      updates.push(...reviewCommentResult.updates);
      if (reviewCommentResult.lastId !== undefined) {
        cursor.lastReviewCommentId = reviewCommentResult.lastId;
      }
    } catch (error) {
      errors.push(
        createGitHubMonitorPhaseError('pr_review_comments', error, input.pr.number),
      );
    }
  }

  if (input.watchKinds.includes('ci.completed')) {
    try {
      const checkRuns = normalizeStatusCheckRollup(
        await input.client.getStatusCheckRollup(
          input.issue.owner,
          input.issue.repo,
          input.pr.number,
        ),
      );
      const retryingCiBootstrap = cursor.ciBootstrapPending === true;
      const ciResult = collectCiUpdates({
        checkRuns,
        lastAggregateBySha: cursor.lastAggregateBySha ?? {},
        emitFirstCompletedAfterBootstrapFailure: retryingCiBootstrap,
        prNumber: input.pr.number,
      });
      updates.push(...ciResult.updates);
      cursor.lastAggregateBySha = ciResult.lastAggregateBySha;
      delete cursor.ciBootstrapPending;
      hasPendingCi = ciResult.hasPendingCi;
    } catch (error) {
      if (input.ciBootstrapPoll) {
        // Do not turn a failed first status snapshot into a completed
        // bootstrap. The next poll must retry CI initialization for this PR.
        cursor.ciBootstrapPending = true;
      }
      errors.push(
        createGitHubMonitorPhaseError('pr_status_checks', error, input.pr.number),
      );
    }
  }

  return {
    updates,
    cursor,
    hasPendingCi,
    errors,
  };
}

function parsePullRequestNumberKey(key: string): number | undefined {
  if (!/^\d+$/.test(key)) return undefined;
  const number = Number(key);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function resolveWatchKinds(
  kinds: GitHubUpdateKind[] | undefined,
): GitHubUpdateKind[] {
  if (!kinds) return [...DEFAULT_GITHUB_WATCH_KINDS];
  return kinds.filter(
    (kind): kind is Exclude<GitHubUpdateKind, 'issue.comment'> =>
      kind === 'pr.review' ||
      kind === 'pr.review_comment' ||
      kind === 'ci.completed',
  );
}

/** GraphQL `statusCheckRollup` の CheckRun / StatusContext を共通形に正規化する。 */
export function normalizeStatusCheckRollup(rollup: unknown): GhCheckRun[] {
  if (!Array.isArray(rollup)) {
    return [];
  }

  const normalized: GhCheckRun[] = [];
  for (const item of rollup) {
    const check = normalizeRollupItem(item);
    if (check) {
      normalized.push(check);
    }
  }
  return normalized;
}

function normalizeRollupItem(item: unknown): GhCheckRun | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const row = item as Record<string, unknown>;
  const typename = row.__typename;

  if (typename === 'StatusContext' || isStatusContextShape(row)) {
    return normalizeStatusContext(row);
  }

  if (typename === 'CheckRun' || (typename === undefined && isCheckRunShape(row))) {
    return normalizeCheckRun(row);
  }

  if (typeof typename === 'string') {
    // WorkflowRun 等の未知型は skip（throw しない）
    return undefined;
  }

  return normalizeCheckRun(row);
}

function isStatusContextShape(row: Record<string, unknown>): boolean {
  return (
    typeof row.context === 'string' &&
    row.state !== undefined &&
    row.name === undefined &&
    row.status === undefined
  );
}

function isCheckRunShape(row: Record<string, unknown>): boolean {
  return typeof row.name === 'string' && typeof row.status === 'string';
}

function normalizeCheckRun(row: Record<string, unknown>): GhCheckRun | undefined {
  const name = typeof row.name === 'string' ? row.name : undefined;
  const status = safeUpperString(row.status, '');
  if (!name || !status) {
    return undefined;
  }

  const normalized: GhCheckRun = {
    name,
    status,
    conclusion: typeof row.conclusion === 'string' ? row.conclusion : null,
    detailsUrl: typeof row.detailsUrl === 'string' ? row.detailsUrl : undefined,
  };
  addCheckRunMetadata(normalized, row);
  return normalized;
}

function normalizeStatusContext(row: Record<string, unknown>): GhCheckRun | undefined {
  const name = typeof row.context === 'string' ? row.context : undefined;
  const state = safeUpperString(row.state, '');
  if (!name || !state) {
    return undefined;
  }

  const detailsUrl = typeof row.targetUrl === 'string' ? row.targetUrl : undefined;
  const normalized: GhCheckRun = { name, status: '', conclusion: null, detailsUrl };
  addCheckRunMetadata(normalized, row);
  if (state === 'PENDING' || state === 'EXPECTED') {
    normalized.status = 'IN_PROGRESS';
    return normalized;
  }
  if (state === 'SUCCESS') {
    normalized.status = 'COMPLETED';
    normalized.conclusion = 'SUCCESS';
    return normalized;
  }
  if (state === 'FAILURE' || state === 'ERROR') {
    normalized.status = 'COMPLETED';
    normalized.conclusion = state;
    return normalized;
  }

  normalized.status = 'COMPLETED';
  normalized.conclusion = state;
  return normalized;
}

function addCheckRunMetadata(
  normalized: GhCheckRun,
  row: Record<string, unknown>,
): void {
  const checkSuite = isRecord(row.checkSuite) ? row.checkSuite : undefined;
  const headSha =
    (typeof row.headSha === 'string' ? row.headSha : undefined) ??
    (checkSuite && isRecord(checkSuite.commit)
      ? readCommitOid(checkSuite.commit)
      : undefined) ??
    (checkSuite && typeof checkSuite.headSha === 'string'
      ? checkSuite.headSha
      : undefined) ??
    (isRecord(row.commit) ? readCommitOid(row.commit) : undefined);
  if (headSha) normalized.headSha = headSha;
}

function readCommitOid(commit: Record<string, unknown>): string | undefined {
  return typeof commit.oid === 'string' && commit.oid.length > 0
    ? commit.oid
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function collectReviewUpdates(
  reviews: GhReview[],
  lastSeenId: string | undefined,
  initialCursorPoll: boolean,
  prNumber: number,
): { updates: GitHubUpdateItem[]; lastId?: string } {
  const submitted = reviews.filter((review) => review.submitted_at);
  if (submitted.length === 0) {
    return { updates: [], lastId: lastSeenId };
  }

  const sorted = [...submitted].sort((a, b) => a.id - b.id);
  const lastNumeric = lastSeenId ? Number.parseInt(lastSeenId, 10) : undefined;
  const newReviews =
    lastNumeric === undefined
      ? sorted
      : sorted.filter((review) => review.id > lastNumeric);

  const lastId = String(sorted[sorted.length - 1]!.id);
  if (initialCursorPoll || newReviews.length === 0) {
    return { updates: [], lastId };
  }

  return {
    updates: newReviews.map((review) => ({
      id: `pr-review:${review.id}`,
      kind: 'pr.review' as const,
      summary: `PR #${prNumber} レビュー（@${review.user.login}・${review.state}）`,
      url: review.html_url,
      author: review.user.login,
      bodyPreview: previewBody(review.body),
      prNumber,
    })),
    lastId,
  };
}

function collectReviewCommentUpdates(
  comments: GhReviewComment[],
  lastSeenId: string | undefined,
  initialCursorPoll: boolean,
  prNumber: number,
): { updates: GitHubUpdateItem[]; lastId?: string } {
  if (comments.length === 0) {
    return { updates: [], lastId: lastSeenId };
  }

  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const lastNumeric = lastSeenId ? Number.parseInt(lastSeenId, 10) : undefined;
  const newComments =
    lastNumeric === undefined
      ? sorted
      : sorted.filter((comment) => comment.id > lastNumeric);

  const lastId = String(sorted[sorted.length - 1]!.id);
  if (initialCursorPoll || newComments.length === 0) {
    return { updates: [], lastId };
  }

  return {
    updates: newComments.map((comment) => ({
      id: `pr-review-comment:${comment.id}`,
      kind: 'pr.review_comment' as const,
      summary: `PR #${prNumber} インラインコメント（@${comment.user.login}・${comment.path}）`,
      url: comment.html_url,
      author: comment.user.login,
      bodyPreview: previewBody(comment.body),
      prNumber,
    })),
    lastId,
  };
}

function collectCiUpdates(input: {
  checkRuns: GhCheckRun[];
  lastAggregateBySha: Record<string, GitHubCiAggregateState>;
  emitFirstCompletedAfterBootstrapFailure: boolean;
  prNumber: number;
}): {
  updates: GitHubUpdateItem[];
  lastAggregateBySha: Record<string, GitHubCiAggregateState>;
  hasPendingCi: boolean;
} {
  const updates: GitHubUpdateItem[] = [];
  const checksBySha = new Map<string, NormalizedCiCheck[]>();
  const lastAggregateBySha = cloneAggregateStates(input.lastAggregateBySha);
  let hasPendingCi = false;

  for (const check of input.checkRuns) {
    const normalized = normalizeCiCheck(check);
    if (!normalized) {
      continue;
    }

    const checks = checksBySha.get(normalized.headSha) ?? [];
    checks.push(normalized);
    checksBySha.set(normalized.headSha, checks);
  }

  for (const [commitSha, checks] of checksBySha) {
    const aggregate = aggregateCiChecks(checks);
    if (aggregate.state === 'running') {
      hasPendingCi = true;
    }
    const previous = lastAggregateBySha[commitSha];
    lastAggregateBySha[commitSha] = aggregate.state;

    // A newly observed SHA/state is the baseline. After a failed bootstrap,
    // emit a non-running aggregate so a completion that happened during the
    // failed poll is not lost.
    const shouldNotify =
      previous !== undefined
        ? previous !== aggregate.state
        : input.emitFirstCompletedAfterBootstrapFailure &&
          aggregate.state !== 'running';
    if (!shouldNotify) {
      continue;
    }

    updates.push({
      id: buildCiUpdateId(input.prNumber, commitSha, aggregate.state),
      kind: 'ci.completed',
      summary: formatCiAggregateSummary(
        input.prNumber,
        commitSha,
        aggregate.state,
        aggregate.failedCheckNames,
      ),
      url: aggregate.detailsUrl,
      prNumber: input.prNumber,
      commitSha,
      aggregateState: aggregate.state,
      ...(aggregate.state === 'failed' && aggregate.failedCheckNames.length > 0
        ? { failedCheckNames: aggregate.failedCheckNames }
        : {}),
    });
  }

  return {
    updates,
    lastAggregateBySha,
    hasPendingCi,
  };
}

function normalizeCiCheck(check: GhCheckRun): NormalizedCiCheck | undefined {
  const name = check.name;
  const status = safeUpperString(check.status, '');
  const headSha = check.headSha?.trim();
  // The GraphQL query requests the commit OID for both rollup types. A
  // malformed/older response without a resolvable SHA is ignored here.
  if (!name || !status || !headSha) {
    return undefined;
  }

  if (isPendingCheckStatus(status)) {
    return {
      name,
      headSha,
      state: 'running',
      ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
    };
  }
  if (status !== 'COMPLETED') {
    return undefined;
  }

  const conclusion = safeUpperString(check.conclusion, '');
  return {
    name,
    headSha,
    state: normalizeCompletedConclusion(conclusion),
    ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
  };
}

function normalizeCompletedConclusion(
  conclusion: string,
): Exclude<NormalizedCiCheckState, 'running'> {
  if (conclusion === 'SUCCESS') {
    return 'complete';
  }
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') {
    return 'skip';
  }
  return 'failed';
}

function buildCiUpdateId(
  prNumber: number,
  commitSha: string,
  aggregateState: GitHubCiAggregateState,
): string {
  return ['ci', prNumber, commitSha, aggregateState].join(':');
}

function aggregateCiChecks(checks: NormalizedCiCheck[]): {
  state: GitHubCiAggregateState;
  failedCheckNames: string[];
  detailsUrl?: string;
} {
  const hasRunning = checks.some((check) => check.state === 'running');
  const failedCheckNames = checks
    .filter((check) => check.state === 'failed')
    .map((check) => check.name)
    .sort();

  let state: GitHubCiAggregateState = 'completed';
  if (hasRunning) {
    state = 'running';
  } else if (failedCheckNames.length > 0) {
    state = 'failed';
  }

  const relevantCheck =
    (state === 'running' && checks.find((check) => check.state === 'running')) ??
    (state === 'failed' && checks.find((check) => check.state === 'failed')) ??
    checks[0];
  return {
    state,
    failedCheckNames,
    ...(relevantCheck?.detailsUrl ? { detailsUrl: relevantCheck.detailsUrl } : {}),
  };
}

function formatCiAggregateSummary(
  prNumber: number,
  commitSha: string,
  state: GitHubCiAggregateState,
  failedCheckNames: string[],
): string {
  const shortSha = commitSha.slice(0, 7);
  const suffix =
    state === 'failed' && failedCheckNames.length > 0
      ? `・${failedCheckNames.join(', ')}`
      : '';
  return `PR #${prNumber} CI 集約（${shortSha}・${state}${suffix}）`;
}

function cloneAggregateStates(
  lastAggregateBySha: Record<string, GitHubCiAggregateState>,
): Record<string, GitHubCiAggregateState> {
  return Object.fromEntries(Object.entries(lastAggregateBySha));
}

function isPendingCheckStatus(status: string): boolean {
  return (
    status === 'QUEUED' ||
    status === 'IN_PROGRESS' ||
    status === 'PENDING' ||
    status === 'WAITING' ||
    status === 'REQUESTED'
  );
}

function previewBody(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= BODY_PREVIEW_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, BODY_PREVIEW_MAX)}…`;
}
