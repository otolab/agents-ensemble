import type { EnsembleConfig } from '../config/types.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import type { GitHubClient } from './github-client.js';
import { createGitHubClient } from './github-client.js';
import type { GitHubMonitorCursor, PullRequestMonitorCursor } from './github-monitor-cursor.js';
import { normalizeGitHubMonitorCursor } from './github-monitor-cursor.js';
import {
  createGitHubMonitorPhaseError,
  safeUpperString,
  type GitHubMonitorPhaseError,
} from './github-monitor-error.js';
import type { GitHubUpdateItem } from './github-update-types.js';

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

  let pullRequests: GhPullRequestRef[];
  try {
    pullRequests = await client.searchLinkedPullRequests(
      issue.owner,
      issue.repo,
      issue.number,
    );
  } catch (error) {
    errors.push(createGitHubMonitorPhaseError('pr_search', error));
    pullRequests = [];
  }
  if (!cursor.pullRequests) {
    cursor.pullRequests = {};
  }

  for (const pr of pullRequests) {
    const prKey = String(pr.number);
    const prCursor = cursor.pullRequests[prKey] ?? {};
    const prResult = await fetchPullRequestUpdates({
      client,
      issue,
      pr,
      prCursor,
      initialCursorPoll: input.initialCursorPoll ?? false,
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
    pendingCheckNames: [...(input.prCursor.pendingCheckNames ?? [])],
    notifiedCheckNames: [...(input.prCursor.notifiedCheckNames ?? [])],
  };
  let hasPendingCi = false;

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

  try {
    const checkRuns = normalizeStatusCheckRollup(
      await input.client.getStatusCheckRollup(
        input.issue.owner,
        input.issue.repo,
        input.pr.number,
      ),
    );
    const ciResult = collectCiUpdates({
      checkRuns,
      pendingCheckNames: cursor.pendingCheckNames ?? [],
      notifiedCheckNames: cursor.notifiedCheckNames ?? [],
      initialCursorPoll: input.initialCursorPoll,
      prNumber: input.pr.number,
    });
    updates.push(...ciResult.updates);
    cursor.pendingCheckNames = ciResult.pendingCheckNames;
    cursor.notifiedCheckNames = ciResult.notifiedCheckNames;
    hasPendingCi = ciResult.hasPendingCi;
  } catch (error) {
    errors.push(
      createGitHubMonitorPhaseError('pr_status_checks', error, input.pr.number),
    );
  }

  return {
    updates,
    cursor,
    hasPendingCi,
    errors,
  };
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

  return {
    name,
    status,
    conclusion: typeof row.conclusion === 'string' ? row.conclusion : null,
    detailsUrl: typeof row.detailsUrl === 'string' ? row.detailsUrl : undefined,
  };
}

function normalizeStatusContext(row: Record<string, unknown>): GhCheckRun | undefined {
  const name = typeof row.context === 'string' ? row.context : undefined;
  const state = safeUpperString(row.state, '');
  if (!name || !state) {
    return undefined;
  }

  const detailsUrl = typeof row.targetUrl === 'string' ? row.targetUrl : undefined;
  if (state === 'PENDING' || state === 'EXPECTED') {
    return { name, status: 'IN_PROGRESS', conclusion: null, detailsUrl };
  }
  if (state === 'SUCCESS') {
    return { name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl };
  }
  if (state === 'FAILURE' || state === 'ERROR') {
    return { name, status: 'COMPLETED', conclusion: state, detailsUrl };
  }

  return { name, status: 'COMPLETED', conclusion: state, detailsUrl };
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
  pendingCheckNames: string[];
  notifiedCheckNames: string[];
  initialCursorPoll: boolean;
  prNumber: number;
}): {
  updates: GitHubUpdateItem[];
  pendingCheckNames: string[];
  notifiedCheckNames: string[];
  hasPendingCi: boolean;
} {
  const updates: GitHubUpdateItem[] = [];
  const pendingNow = new Set<string>();
  const previousPending = new Set(input.pendingCheckNames);
  const notified = new Set(input.notifiedCheckNames);
  const hadPreviousSnapshot = previousPending.size > 0;

  for (const check of input.checkRuns) {
    const name = check.name;
    const status = safeUpperString(check.status, '');
    if (!name || !status) {
      continue;
    }
    if (isPendingCheckStatus(status)) {
      pendingNow.add(name);
      continue;
    }
    if (status !== 'COMPLETED') {
      continue;
    }
    const conclusion = safeUpperString(check.conclusion, 'UNKNOWN');
    if (!hadPreviousSnapshot || !previousPending.has(name)) {
      continue;
    }
    if (notified.has(name)) {
      continue;
    }
    if (input.initialCursorPoll) {
      notified.add(name);
      continue;
    }
    updates.push({
      id: `ci:${input.prNumber}:${name}:${conclusion}`,
      kind: 'ci.completed',
      summary: `PR #${input.prNumber} CI 完了（${name}・${conclusion}）`,
      url: check.detailsUrl,
      prNumber: input.prNumber,
      checkName: name,
      checkConclusion: conclusion,
    });
    notified.add(name);
  }

  return {
    updates,
    pendingCheckNames: [...pendingNow],
    notifiedCheckNames: [...notified],
    hasPendingCi: pendingNow.size > 0,
  };
}

function isPendingCheckStatus(status: string): boolean {
  return (
    status === 'QUEUED' ||
    status === 'IN_PROGRESS' ||
    status === 'PENDING' ||
    status === 'WAITING'
  );
}

function previewBody(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= BODY_PREVIEW_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, BODY_PREVIEW_MAX)}…`;
}
