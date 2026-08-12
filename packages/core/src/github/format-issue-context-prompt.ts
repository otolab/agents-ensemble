import yaml from 'js-yaml';
import type { IssueComment, IssueContext } from './issue-context.js';

/**
 * Issue 文脈を conductor 初回 send 用 Markdown（セクション + YAML メタ）に整形する。
 * objective の Issue 番号と対応する正本。URL は base objective に載るためここでは繰り返さない。
 */
export function formatIssueContextForPrompt(context: IssueContext): string {
  const sections: string[] = [
    'Issue の正本（title / body / comments）。objective の Issue 番号と対応する。',
    '',
    '## Description',
    '',
    context.body.trim() || '(empty)',
  ];

  if (context.comments.length > 0) {
    sections.push('', '## Comments');
    for (const comment of context.comments) {
      sections.push('', formatCommentSection(comment));
    }
  }

  sections.push('', formatIssueContextYaml(context));
  return sections.join('\n');
}

/** Issue メタデータと comments 索引を YAML ブロックに整形する。 */
export function formatIssueContextYaml(context: IssueContext): string {
  const data = {
    number: context.issue.number,
    title: context.title,
    state: context.state,
    labels: context.labels,
    comments: context.comments.map((comment) => ({
      author: comment.author,
      createdAt: comment.createdAt,
      body: comment.body,
    })),
  };
  return fencedYaml('issue.context', data);
}

function formatCommentSection(comment: IssueComment): string {
  return [
    `### @${comment.author} (${comment.createdAt})`,
    '',
    comment.body,
  ].join('\n');
}

function fencedYaml(label: string, data: unknown): string {
  return [
    '```yaml',
    `# ${label}`,
    yaml.dump(data, { lineWidth: 120 }).trimEnd(),
    '```',
  ].join('\n');
}
