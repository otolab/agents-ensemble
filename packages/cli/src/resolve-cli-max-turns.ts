/** `packages/core` の `DEFAULT_MAX_ISSUE_TURNS` と同期。 */
const NON_INTERACTIVE_DEFAULT_MAX_TURNS = 5;

export interface ResolveCliMaxTurnsInput {
  interactive: boolean;
  noMaxTurns?: boolean;
  maxTurns?: number;
}

/** CLI の `--max-turns` / `--no-max-turns` と TTY 有無から `maxTurns` を決定する。 */
export function resolveCliMaxTurns(input: ResolveCliMaxTurnsInput): number {
  if (input.noMaxTurns) {
    return 0;
  }
  if (input.maxTurns !== undefined) {
    return input.maxTurns;
  }
  return input.interactive ? 0 : NON_INTERACTIVE_DEFAULT_MAX_TURNS;
}
