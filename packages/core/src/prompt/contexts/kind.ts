import { parseIssueUrl } from '../../issue/issue-ref.js';
import type { EnsembleSessionState } from '../../profile/types.js';

/** system prompt compile 時に渡す Issue セッション文脈。 */
export interface EnsembleContext extends EnsembleSessionState {
  kind: string;
  issueUrl: string;
  issueNumber: number;
}

/** worker dispatch 時に instructions へ載せる実行時データ。 */
export type WorkerDispatchContext = EnsembleContext & {
  worktreePath?: string;
  worktreeInRepo?: boolean;
};

export function ensembleContext(
  kind: string,
  issueUrl: string,
  session: EnsembleSessionState,
): EnsembleContext {
  const ref = parseIssueUrl(issueUrl);
  return {
    kind,
    issueUrl: ref.url,
    issueNumber: ref.number,
    workers: session.workers,
    kinds: session.kinds,
  };
}
