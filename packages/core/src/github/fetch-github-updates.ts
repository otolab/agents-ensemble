import { parseIssueUrl } from '../issue/issue-ref.js';
import type { GitHubMonitorCursor, PullRequestMonitorCursor } from './github-monitor-cursor.js';
import { normalizeGitHubMonitorCursor } from './github-monitor-cursor.js';
import type { GitHubUpdateItem } from './github-update-types.js';
import { runGh } from './run-gh.js';

const BODY_PREVIEW_MAX = 280;

export interface FetchGitHubUpdatesInput {
  issueUrl: string;
  cursor: GitHubMonitorCursor;
  /** true のときカーソルのみ進め、更新は返さない（カーソル空の新規セッション初回 poll のみ）。 */
  initialCursorPoll?: boolean;
  cwd?: string;
  runGhFn?: typeof runGh;
}

export interface FetchGitHubUpdatesResult {
  updates: GitHubUpdateItem[];
  cursor: GitHubMonitorCursor;
  /** いずれかの PR で CI が pending。poll 間隔短縮の判断材料。 */
  hasPendingCi: boolean;
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
  const gh = input.runGhFn ?? runGh;
  const issue = parseIssueUrl(input.issueUrl);
  const cursor = normalizeGitHubMonitorCursor(input.cursor);
  const updates: GitHubUpdateItem[] = [];
  let hasPendingCi = false;

  const issueComments = await fetchIssueComments(gh, issue, input.cwd);
  const { updates: commentUpdates, lastId } = collectIssueCommentUpdates(
    issueComments,
    cursor.lastIssueCommentId,
    input.initialCursorPoll ?? false,
  );
  updates.push(...commentUpdates);
  if (lastId !== undefined) {
    cursor.lastIssueCommentId = lastId;
  }

  const pullRequests = await fetchLinkedPullRequests(gh, issue, input.cwd);
  if (!cursor.pullRequests) {
    cursor.pullRequests = {};
  }

  for (const pr of pullRequests) {
    const prKey = String(pr.number);
    const prCursor = cursor.pullRequests[prKey] ?? {};
    const prResult = await fetchPullRequestUpdates({
      gh,
      issue,
      pr,
      prCursor,
      initialCursorPoll: input.initialCursorPoll ?? false,
      cwd: input.cwd,
    });
    updates.push(...prResult.updates);
    cursor.pullRequests[prKey] = prResult.cursor;
    if (prResult.hasPendingCi) {
      hasPendingCi = true;
    }
  }

  return { updates, cursor, hasPendingCi };
}

async function fetchIssueComments(
  gh: typeof runGh,
  issue: ReturnType<typeof parseIssueUrl>,
  cwd?: string,
): Promise<GhIssueComment[]> {
  const stdout = await gh(
    [
      'api',
      `repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments`,
      '--paginate',
    ],
    { cwd },
  );
  return JSON.parse(stdout) as GhIssueComment[];
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

async function fetchLinkedPullRequests(
  gh: typeof runGh,
  issue: ReturnType<typeof parseIssueUrl>,
  cwd?: string,
): Promise<GhPullRequestRef[]> {
  try {
    const stdout = await gh(
      [
        'search',
        'prs',
        String(issue.number),
        '--repo',
        `${issue.owner}/${issue.repo}`,
        '--json',
        'number,title,url,state',
        '--limit',
        '20',
      ],
      { cwd },
    );
    const results = JSON.parse(stdout) as GhPullRequestRef[];
    return results.filter((pr) => pr.state === 'OPEN' || pr.state === 'open');
  } catch {
    return [];
  }
}

async function fetchPullRequestUpdates(input: {
  gh: typeof runGh;
  issue: ReturnType<typeof parseIssueUrl>;
  pr: GhPullRequestRef;
  prCursor: PullRequestMonitorCursor;
  initialCursorPoll: boolean;
  cwd?: string;
}): Promise<{
  updates: GitHubUpdateItem[];
  cursor: PullRequestMonitorCursor;
  hasPendingCi: boolean;
}> {
  const updates: GitHubUpdateItem[] = [];
  const cursor: PullRequestMonitorCursor = {
    lastReviewId: input.prCursor.lastReviewId,
    lastReviewCommentId: input.prCursor.lastReviewCommentId,
    pendingCheckNames: [...(input.prCursor.pendingCheckNames ?? [])],
    notifiedCheckNames: [...(input.prCursor.notifiedCheckNames ?? [])],
  };

  const reviews = await fetchReviews(input.gh, input.issue, input.pr.number, input.cwd);
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

  const reviewComments = await fetchReviewComments(
    input.gh,
    input.issue,
    input.pr.number,
    input.cwd,
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

  const checkRuns = await fetchStatusCheckRollup(
    input.gh,
    input.issue,
    input.pr.number,
    input.cwd,
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

  return {
    updates,
    cursor,
    hasPendingCi: ciResult.hasPendingCi,
  };
}

async function fetchReviews(
  gh: typeof runGh,
  issue: ReturnType<typeof parseIssueUrl>,
  prNumber: number,
  cwd?: string,
): Promise<GhReview[]> {
  const stdout = await gh(
    [
      'api',
      `repos/${issue.owner}/${issue.repo}/pulls/${prNumber}/reviews`,
      '--paginate',
    ],
    { cwd },
  );
  return JSON.parse(stdout) as GhReview[];
}

async function fetchReviewComments(
  gh: typeof runGh,
  issue: ReturnType<typeof parseIssueUrl>,
  prNumber: number,
  cwd?: string,
): Promise<GhReviewComment[]> {
  const stdout = await gh(
    [
      'api',
      `repos/${issue.owner}/${issue.repo}/pulls/${prNumber}/comments`,
      '--paginate',
    ],
    { cwd },
  );
  return JSON.parse(stdout) as GhReviewComment[];
}

async function fetchStatusCheckRollup(
  gh: typeof runGh,
  issue: ReturnType<typeof parseIssueUrl>,
  prNumber: number,
  cwd?: string,
): Promise<GhCheckRun[]> {
  const stdout = await gh(
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      `${issue.owner}/${issue.repo}`,
      '--json',
      'statusCheckRollup',
    ],
    { cwd },
  );
  const data = JSON.parse(stdout) as { statusCheckRollup?: unknown };
  return normalizeStatusCheckRollup(data.statusCheckRollup);
}

/** `gh pr view --json statusCheckRollup` の CheckRun / StatusContext を共通形に正規化する。 */
function normalizeStatusCheckRollup(rollup: unknown): GhCheckRun[] {
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
  if (row.__typename === 'StatusContext') {
    return normalizeStatusContext(row);
  }

  const name = typeof row.name === 'string' ? row.name : undefined;
  const status = typeof row.status === 'string' ? row.status : undefined;
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
  const state = typeof row.state === 'string' ? row.state.toUpperCase() : undefined;
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
    const status = check.status?.toUpperCase();
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
    const conclusion = (check.conclusion ?? 'UNKNOWN').toUpperCase();
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
