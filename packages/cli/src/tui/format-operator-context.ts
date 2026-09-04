import type { OperatorInputContext } from '@agents-ensemble/core';
import { parseIssueUrl } from '@agents-ensemble/core';

function formatMaxTurnsLabel(maxTurns: number | null): string {
  return maxTurns === null ? '∞' : String(maxTurns);
}

export type IssueLinkMode = 'osc8' | 'label' | 'url';

export interface OperatorContextHintOptions {
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
}

/** Issue URL をコンテキスト行で使う短い識別子へ変換する。 */
export function formatIssueLabel(issueUrl: string): string {
  const normalizedUrl = issueUrl.trim();
  try {
    const { owner, repo, number } = parseIssueUrl(normalizedUrl);
    return `${owner}/${repo}#${number}`;
  } catch {
    return normalizedUrl;
  }
}

function escapeOsc8Url(issueUrl: string): string {
  return issueUrl.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** OSC 8 の hyperlink シーケンスでラベルを包む。 */
export function formatOsc8Link(label: string, issueUrl: string): string {
  const osc8 = '\u001b]8;;';
  const bell = '\u0007';
  return `${osc8}${escapeOsc8Url(issueUrl)}${bell}${label}${osc8}${bell}`;
}

/** Issue の表示を端末互換性に応じて選ぶ。 */
export function formatIssueReference(
  issueUrl: string,
  mode: IssueLinkMode = 'osc8',
): string {
  const normalizedUrl = issueUrl.trim();
  if (mode === 'url') {
    return normalizedUrl;
  }

  const label = formatIssueLabel(normalizedUrl);
  return mode === 'osc8' ? formatOsc8Link(label, normalizedUrl) : label;
}

/** 任意のコンテキスト文言の先頭へ Issue 参照を追加する。 */
export function prependIssueReference(
  issueUrl: string | undefined,
  hint: string,
  mode: IssueLinkMode = 'osc8',
): string {
  if (!issueUrl?.trim()) {
    return hint;
  }

  return `${formatIssueReference(issueUrl, mode)} — ${hint}`;
}

interface TerminalEnvironment {
  [key: string]: string | undefined;
  CI?: string;
  FORCE_HYPERLINK?: string;
  KITTY_WINDOW_ID?: string;
  KONSOLE_VERSION?: string;
  TERM?: string;
  TERM_PROGRAM?: string;
  VTE_VERSION?: string;
  WT_SESSION?: string;
}

/** 既知の OSC 8 対応端末を判定する（未知の端末はラベルのみ）。 */
export function supportsOsc8Hyperlinks(
  environment: TerminalEnvironment = process.env,
): boolean {
  if (environment.FORCE_HYPERLINK === '0' || environment.TERM === 'dumb') {
    return false;
  }
  if (environment.FORCE_HYPERLINK === '1') {
    return true;
  }
  if (environment.CI) {
    return false;
  }

  if (
    environment.WT_SESSION ||
    environment.KITTY_WINDOW_ID ||
    environment.KONSOLE_VERSION ||
    environment.TERM === 'xterm-kitty'
  ) {
    return true;
  }

  if (
    environment.TERM_PROGRAM === 'Apple_Terminal' ||
    environment.TERM_PROGRAM === 'Hyper' ||
    environment.TERM_PROGRAM === 'WezTerm' ||
    environment.TERM_PROGRAM === 'iTerm.app' ||
    environment.TERM_PROGRAM === 'vscode'
  ) {
    return true;
  }

  const vteVersion = Number.parseInt(environment.VTE_VERSION ?? '', 10);
  return Number.isFinite(vteVersion) && vteVersion >= 5000;
}

export interface OpenQuestionSelectionContext {
  id: string;
  index: number;
  total: number;
}

/** 入力欄直上に表示するオペレータ向けコンテキスト行。 */
export function formatOperatorContextHint(
  context: OperatorInputContext | undefined,
  selection?: OpenQuestionSelectionContext,
  options: OperatorContextHintOptions = {},
): string {
  if (!context) {
    return prependIssueReference(options.issueUrl, 'operator> ', options.issueLinkMode);
  }

  if (context.openQuestions.length > 0) {
    if (selection) {
      return prependIssueReference(
        options.issueUrl,
        `${selection.id} (${selection.index + 1}/${selection.total}) への回答 — Shift+↑↓で選択 · Enter で送信`,
        options.issueLinkMode,
      );
    }
    return prependIssueReference(
      options.issueUrl,
      'open question あり — Shift+↑↓で選択して回答',
      options.issueLinkMode,
    );
  }

  return prependIssueReference(
    options.issueUrl,
    `自律ターン ${context.autonomousTurns}/${formatMaxTurnsLabel(context.maxTurns)} — 任意のタイミングで入力（/exit で終了）`,
    options.issueLinkMode,
  );
}
