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

export function ghPrViewStatusCheckRollupJson(checkRuns: readonly object[]): string {
  return JSON.stringify({ statusCheckRollup: checkRuns });
}
