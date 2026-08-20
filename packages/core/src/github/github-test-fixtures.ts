/** 実 `gh pr view --json statusCheckRollup` に近い CheckRun 配列。 */
export const GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS = [
  {
    __typename: 'CheckRun',
    name: 'ci/test',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/org/repo/actions/runs/1',
  },
] as const;

export const GH_STATUS_CHECK_ROLLUP_IN_PROGRESS = [
  {
    __typename: 'CheckRun',
    name: 'ci/test',
    status: 'IN_PROGRESS',
    conclusion: '',
    detailsUrl: 'https://github.com/org/repo/actions/runs/1',
  },
] as const;

/** レガシー commit status（`status` ではなく `state` / `context`）。 */
export const GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING = [
  {
    __typename: 'StatusContext',
    context: 'ci/legacy',
    state: 'PENDING',
    targetUrl: 'https://github.com/org/repo/actions/runs/2',
  },
] as const;

export const GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_SUCCESS = [
  {
    __typename: 'StatusContext',
    context: 'ci/legacy',
    state: 'SUCCESS',
    targetUrl: 'https://github.com/org/repo/actions/runs/2',
  },
] as const;

/**
 * Issue #185 再現: `__typename` 欠落の StatusContext（gap A）。
 * 実環境の GraphQL レスポンスで `__typename` が省略されるケース。
 */
export const GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_NO_TYPENAME = [
  {
    context: 'ci/legacy-no-typename',
    state: 'PENDING',
    targetUrl: 'https://github.com/org/repo/actions/runs/3',
  },
] as const;

/**
 * Issue #185 再現: `conclusion` が非 string（gap B）。
 * `(check.conclusion ?? 'UNKNOWN').toUpperCase()` が落ちるパターン。
 */
export const GH_STATUS_CHECK_ROLLUP_NON_STRING_CONCLUSION = [
  {
    __typename: 'CheckRun',
    name: 'ci/broken-conclusion',
    status: 'COMPLETED',
    conclusion: 0,
    detailsUrl: 'https://github.com/org/repo/actions/runs/4',
  },
] as const;

/**
 * Issue #185 再現: 未知 `__typename`（gap C — WorkflowRun）。
 */
export const GH_STATUS_CHECK_ROLLUP_WORKFLOW_RUN = [
  {
    __typename: 'WorkflowRun',
    name: 'ci/workflow',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
  },
] as const;

/** Issue #185 再現: 複合 rollup（正常 + 異常エントリ混在）。 */
export const GH_STATUS_CHECK_ROLLUP_MIXED_ISSUE_185 = [
  ...GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_NO_TYPENAME,
  ...GH_STATUS_CHECK_ROLLUP_NON_STRING_CONCLUSION,
  ...GH_STATUS_CHECK_ROLLUP_WORKFLOW_RUN,
  ...GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS,
] as const;

export function ghPrViewStatusCheckRollupJson(checkRuns: readonly object[]): string {
  return JSON.stringify({ statusCheckRollup: checkRuns });
}
