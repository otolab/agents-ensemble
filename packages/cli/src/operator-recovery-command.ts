import type {
  OperatorInputBindingApi,
  PiAuthRecoverySnapshot,
  PiAuthRecoverySnapshotSummary,
} from '@agents-ensemble/core';

export interface OperatorRecoveryInspection {
  title: string;
  text: string;
  recoveryId?: string;
  expiresAt?: number;
  sensitive?: boolean;
}

export interface OperatorRecoveryCommandResult {
  handled: boolean;
  inspection?: OperatorRecoveryInspection;
}

export interface ExecutePiAuthRecoveryCommandOptions {
  /** Sensitive payloads are shown only on an interactive local terminal. */
  canDisplaySensitiveContent?: boolean;
}

const RECOVERY_COMMAND_PATTERN = /^[\t ]*\/recovery(?=$|[\t ])([\s\S]*)$/iu;
const RECOVERY_SNAPSHOT_ID_PATTERN = /^pi-auth-recovery-\d+$/u;

/** Executes local-only `/recovery` commands before operator text reaches core. */
export function executePiAuthRecoveryCommand(
  api: OperatorInputBindingApi | undefined,
  input: string,
  options: ExecutePiAuthRecoveryCommandOptions = {},
): OperatorRecoveryCommandResult {
  const match = RECOVERY_COMMAND_PATTERN.exec(input);
  if (!match) {
    return { handled: false };
  }

  const commandAndArgs = match[1]!.trim();
  const [command = 'list', recoveryId, ...extraArgs] =
    commandAndArgs.length === 0
      ? []
      : commandAndArgs.split(/[ \t]+/u);

  if (command === 'hide' && recoveryId === undefined) {
    return { handled: true };
  }

  if (command === 'list' && recoveryId === undefined) {
    return {
      handled: true,
      inspection: {
        title: 'Pi recovery inbox',
        text: formatRecoverySnapshotList(api?.listPiAuthRecoverySnapshots?.()),
      },
    };
  }

  if (
    (command === 'show' || command === 'clear') &&
    recoveryId !== undefined &&
    extraArgs.length === 0 &&
    RECOVERY_SNAPSHOT_ID_PATTERN.test(recoveryId)
  ) {
    if (command === 'clear') {
      const removed =
        api?.clearPiAuthRecoverySnapshot?.(recoveryId) ?? false;
      return {
        handled: true,
        inspection: {
          title: 'Pi recovery inbox',
          text: removed
            ? [
                `Snapshot ${recoveryId} を recovery inbox から削除しました。`,
                'メモリ上の完全消去は保証しません。',
              ].join(' ')
            : [
                `Snapshot ${recoveryId} は見つかりません`,
                '（期限切れ、削除済み、またはこの session で未作成）。',
              ].join(''),
        },
      };
    }

    if (!options.canDisplaySensitiveContent) {
      return {
        handled: true,
        inspection: {
          title: 'Pi recovery inbox',
          text: '本文は機密を含む可能性があるため、対話 TTY 上でのみ表示できます。TTY 出力を確認してから再度実行してください。',
        },
      };
    }

    const snapshot = api?.getPiAuthRecoverySnapshot?.(recoveryId);
    return {
      handled: true,
      inspection: {
        title: `Sensitive recovery content · ${recoveryId}`,
        recoveryId,
        ...(snapshot ? { expiresAt: snapshot.expiresAt, sensitive: true } : {}),
        text: snapshot
          ? formatRecoverySnapshot(snapshot)
          : `Snapshot ${recoveryId} は見つかりません（期限切れ、削除済み、またはこの session で未作成）。`,
      },
    };
  }

  return {
    handled: true,
    inspection: {
      title: 'Pi recovery inbox',
      text: [
        '使い方:',
        '  /recovery list',
        '  /recovery show <recoveryId>',
        '  /recovery clear <recoveryId>',
        '  /recovery hide',
        '',
        '内容を自動で再送する操作はありません。',
      ].join('\n'),
    },
  };
}

function formatRecoverySnapshotList(
  snapshots: PiAuthRecoverySnapshotSummary[] | undefined,
): string {
  if (!snapshots || snapshots.length === 0) {
    return [
      '確認できる snapshot はありません。',
      '対象は最終 Pi API-key resolver failure の通常 dispatch です。',
    ].join('\n');
  }

  return [
    `${snapshots.length} 件を process memory に保持しています（最大4件、failure から30分）。`,
    '本文はここには表示しません。個別表示には /recovery show <recoveryId> を使います。',
    '本文は切り詰めません。単一 dispatch の byte 上限はありません。',
    '',
    ...snapshots.map((snapshot) =>
      [
        `${snapshot.recoveryId} · send #${snapshot.sendCount}`,
        `  events: ${snapshot.eventTypes
          .map(escapeTerminalControlCharacters)
          .join(', ')} (${snapshot.eventCount})`,
        `  source: ${escapeTerminalControlCharacters(snapshot.sourceKey)}`,
        `  content: ${snapshot.contentBytes} UTF-8 bytes`,
        `  expires: ${new Date(snapshot.expiresAt).toISOString()}`,
        `  toolCallStarted: ${snapshot.toolCallStarted} · automaticRetryAttempts: ${snapshot.automaticRetryAttempts}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function formatRecoverySnapshot(snapshot: PiAuthRecoverySnapshot): string {
  return [
    '機密情報を含む可能性があります。画面共有・端末録画・出力 capture による漏えいは防げません。',
    'これは失敗 dispatch 時に conductor へ渡した event 内容を整形した local copy です。/recovery は conductor へ送信せず、元 event も再実行しません。',
    `send #${snapshot.failedDispatch.sendCount} · events: ${snapshot.failedDispatch.eventTypes.join(', ')} (${snapshot.failedDispatch.eventCount})`,
    `toolCallStarted: ${snapshot.failure.toolCallStarted} · automaticRetryAttempts: ${snapshot.failure.automaticRetryAttempts}`,
    `captured: ${new Date(snapshot.createdAt).toISOString()} · expires: ${new Date(snapshot.expiresAt).toISOString()}`,
    '',
    '--- 元 dispatch の event 内容 ---',
    escapeTerminalControlCharacters(snapshot.content),
    '--- 内容ここまで ---',
    '',
    'toolCallStarted は tool 開始 callback を観測したかを示します。false でも副作用がなかった証拠にはなりません。',
    '元 event は再送されません。本文全体をそのまま再入力すると、すでに起きた副作用が重なる可能性があります。',
    '続ける場合は現在の worker / worktree 状態と実行済み副作用を確認し、確認できた未完了分だけを新しい指示として入力してください。',
  ].join('\n');
}

function escapeTerminalControlCharacters(input: string): string {
  let output = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    if (character === '\n') {
      output += '\n';
    } else if (character === '\t') {
      output += '\\t';
    } else if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else {
      output += character;
    }
  }
  return output;
}
