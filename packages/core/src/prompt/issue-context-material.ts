import type { IssueContext } from '../github/issue-context.js';
import type { ResolvedProfileMaterial } from '../profile/types.js';
import { formatIssueContextForPrompt } from '../github/format-issue-context-prompt.js';

/** Issue 文脈を Prepared Materials 用 material に変換する。 */
export function issueContextMaterial(
  context: IssueContext,
): ResolvedProfileMaterial {
  return {
    id: 'issue-context',
    title: `Issue context (#${context.issue.number})`,
    content: formatIssueContextForPrompt(context),
  };
}
