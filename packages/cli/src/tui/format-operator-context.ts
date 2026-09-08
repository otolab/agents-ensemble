import type { OpenQuestion, OperatorInputContext } from '@agents-ensemble/core';
import { buildIssueUrl, parseIssueUrl } from '@agents-ensemble/core';
import {
  OPERATOR_INPUT_DISCRETIONARY_HINT,
  OPERATOR_INPUT_POST_LOOP_HINT,
  OPERATOR_INPUT_SHUTTING_DOWN_HINT,
} from './tui-layout-constants.js';

export type IssueLinkMode = 'osc8' | 'label' | 'url';

export interface OperatorContextHintOptions {
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
}

/** OSC 8 のリンク先に使う GitHub Issue URL を正規化する。 */
function resolveIssueLinkTarget(issueUrl: string): string {
  const normalizedUrl = issueUrl.trim();
  try {
    const { owner, repo, number } = parseIssueUrl(normalizedUrl);
    return buildIssueUrl({ owner, repo, number });
  } catch {
    // Keep the existing display fallback for malformed input. Valid Issue
    // references always use the canonical target built above.
    return issueUrl;
  }
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
  const target = resolveIssueLinkTarget(issueUrl);
  return `${osc8}${escapeOsc8Url(target)}${bell}${label}${osc8}${bell}`;
}

/** Issue の表示を端末互換性に応じて選ぶ。 */
export function formatIssueReference(
  issueUrl: string,
  mode: IssueLinkMode = 'osc8',
): string {
  const normalizedUrl = resolveIssueLinkTarget(issueUrl.trim());
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

export type OperatorInputDisplayMode = 'withQuestions' | 'noQuestions';

export interface OperatorInputDisplayResolution {
  mode: OperatorInputDisplayMode;
  hintLines: string[];
}

/**
 * Operator input の表示モードと prompt 行を解決する。
 *
 * 表示モード自体は open question の有無による2値だけとし、Operator input には
 * 入力を促す行のみを載せる（Issue 参照や post-loop 待機などの status は載せない）。
 */
export function resolveOperatorInputDisplayMode(params: {
  openQuestions: readonly OpenQuestion[];
  selection?: OpenQuestionSelectionContext;
  postLoopWaiting?: boolean;
  shuttingDown?: boolean;
}): OperatorInputDisplayResolution {
  const mode: OperatorInputDisplayMode =
    params.openQuestions.length > 0 ? 'withQuestions' : 'noQuestions';

  if (params.shuttingDown) {
    return {
      mode,
      hintLines: [OPERATOR_INPUT_SHUTTING_DOWN_HINT],
    };
  }

  if (params.postLoopWaiting && mode === 'noQuestions') {
    return {
      mode,
      hintLines: [OPERATOR_INPUT_POST_LOOP_HINT],
    };
  }

  if (mode === 'withQuestions') {
    const questionHint = params.selection
      ? `${params.selection.id} (${params.selection.index + 1}/${params.selection.total}) への回答 — Shift+↑↓で選択 · Enter で送信`
      : 'open question あり — Shift+↑↓で選択して回答';
    return { mode, hintLines: [questionHint] };
  }

  return {
    mode,
    hintLines: [OPERATOR_INPUT_DISCRETIONARY_HINT],
  };
}

/** 入力欄直上に表示するオペレータ向け prompt 行。 */
export function formatOperatorContextHint(
  context: OperatorInputContext | undefined,
  selection?: OpenQuestionSelectionContext,
): string {
  if (!context) {
    return 'operator> ';
  }

  const resolution = resolveOperatorInputDisplayMode({
    openQuestions: context.openQuestions,
    selection,
  });
  return resolution.hintLines[0] ?? 'operator> ';
}
