import {
  CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
  CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT,
  CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS,
  CONDUCTOR_RECOVERY_TOTAL_BYTE_LIMIT,
} from './conductor-recovery-inbox.js';
import type {
  ConductorRecoverySnapshot,
  ConductorRecoverySnapshotSummary,
} from './conductor-recovery-inbox.js';

export interface RecoveryInboxCommandApi {
  listRecoverySnapshots?: () => ConductorRecoverySnapshotSummary[];
  getRecoverySnapshot?: (
    recoveryId: string,
  ) => ConductorRecoverySnapshot | undefined;
  clearRecoverySnapshot?: (recoveryId: string) => boolean;
  continueAfterRecovery?: () => boolean;
  recoveryAttentionAttemptId?: () => string | undefined;
}

export interface OperatorRecoveryInspection {
  title: string;
  text: string;
  recoveryId?: string;
  expiresAt?: number;
  sensitive?: boolean;
}

export interface RecoveryInboxCommandResult {
  handled: boolean;
  inspection?: OperatorRecoveryInspection;
}

export interface ExecuteRecoveryInboxCommandOptions {
  /** Sensitive input is returned only to an interactive local terminal. */
  canDisplaySensitiveContent?: boolean;
}

const RECOVERY_COMMAND_PATTERN = /^[\t ]*\/recovery(?=$|[\t ])([\s\S]*)$/iu;
const RECOVERY_SNAPSHOT_ID_PATTERN = /^conductor-recovery-\d+$/u;

/** Executes local-only recovery commands before text reaches a conductor. */
export function executeRecoveryInboxCommand(
  api: RecoveryInboxCommandApi | undefined,
  input: string,
  options: ExecuteRecoveryInboxCommandOptions = {},
): RecoveryInboxCommandResult {
  const match = RECOVERY_COMMAND_PATTERN.exec(input);
  if (!match) return { handled: false };

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
        title: 'Conductor recovery inbox',
        text: formatRecoverySnapshotList(
          api?.listRecoverySnapshots?.(),
          api?.recoveryAttentionAttemptId?.(),
        ),
      },
    };
  }

  if (command === 'continue' && recoveryId === undefined) {
    const continued = api?.continueAfterRecovery?.() ?? false;
    return {
      handled: true,
      inspection: {
        title: 'Conductor recovery',
        text: continued
          ? '未確定だった send の確認を受け付けました。失敗した入力は再送せず、後続 queue の dispatch を再開します。'
          : '確認待ちの send はありません。',
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
      const removed = api?.clearRecoverySnapshot?.(recoveryId) ?? false;
      return {
        handled: true,
        inspection: {
          title: 'Conductor recovery inbox',
          text: removed
            ? [
                `Snapshot ${recoveryId} を recovery inbox から削除しました。`,
                'メモリ上の完全消去は保証しません。',
              ].join(' ')
            : `Snapshot ${recoveryId} は見つかりません（期限切れ、削除済み、またはこの process で未作成）。`,
        },
      };
    }

    if (!options.canDisplaySensitiveContent) {
      return {
        handled: true,
        inspection: {
          title: 'Conductor recovery inbox',
          text: '本文は機密を含む可能性があるため、対話 TTY 上でのみ表示できます。この実行環境では本文を確認できません。',
        },
      };
    }

    const snapshot = api?.getRecoverySnapshot?.(recoveryId);
    return {
      handled: true,
      inspection: {
        title: `Sensitive recovery content · ${recoveryId}`,
        recoveryId,
        ...(snapshot
          ? { expiresAt: snapshot.expiresAt, sensitive: true }
          : {}),
        text: snapshot
          ? formatRecoverySnapshot(snapshot)
          : `Snapshot ${recoveryId} は見つかりません（期限切れ、削除済み、またはこの process で未作成）。`,
      },
    };
  }

  return {
    handled: true,
    inspection: {
      title: 'Conductor recovery inbox',
      text: [
        '使い方:',
        '  /recovery list',
        '  /recovery show <recoveryId>',
        '  /recovery clear <recoveryId>',
        '  /recovery continue',
        '  /recovery hide',
        '',
        'continue は現在の send 結果を確認した後に使ってください。失敗した入力は自動再送されません。',
      ].join('\n'),
    },
  };
}

function formatRecoverySnapshotList(
  snapshots: ConductorRecoverySnapshotSummary[] | undefined,
  attentionAttemptId: string | undefined,
): string {
  const maxBytes = CONDUCTOR_RECOVERY_TOTAL_BYTE_LIMIT / 1_048_576;
  const ttlMinutes = CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS / 60_000;
  const heading = [
    `最大${CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT}件・合計${maxBytes} MiB、各dispatch ${CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT / 1_048_576} MiBまでを${ttlMinutes}分保持します。`,
    '失敗内容はoperator-authored inputだけです。本文は表示せず、失敗後に古いsnapshotを自動削除しません。',
  ];

  if (!snapshots || snapshots.length === 0) {
    return [
      ...heading,
      '確認できる snapshot はありません。',
      ...(attentionAttemptId
        ? [`attempt ${attentionAttemptId} の結果確認後に /recovery continue を実行できます。`]
        : []),
    ].join('\n');
  }

  return [
    ...heading,
    '容量が満杯の間は対象の入力をqueueに残してdispatchを待ちます。/recovery clear <id> またはTTL後に再開します。',
    '',
    ...snapshots.map((snapshot) =>
      [
        `${snapshot.recoveryId}${snapshot.recoveryId.endsWith(`-${attentionAttemptId ?? ''}`) ? ' · confirmation pending' : ''} · ${snapshot.workflow} · ${snapshot.backend}`,
        `  send #${snapshot.sendCount} · source: ${escapeTerminalControlCharacters(snapshot.sourceKey)}`,
        `  events: ${snapshot.eventTypes.map(escapeTerminalControlCharacters).join(', ')} · operator inputs: ${snapshot.inputCount}`,
        `  result: ${escapeTerminalControlCharacters(snapshot.status)} (${snapshot.failureClass}) · toolCallStarted: ${snapshot.toolCallStarted}`,
        `  automatic reconnect: ${formatAutomaticReconnect(snapshot.automaticReconnect)} · automatic retries: ${snapshot.automaticRetryAttempts}`,
        `  content: ${snapshot.contentBytes} UTF-8 bytes · expires: ${new Date(snapshot.expiresAt).toISOString()}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function formatRecoverySnapshot(snapshot: ConductorRecoverySnapshot): string {
  const inputs = snapshot.inputTexts.map((text, index) =>
    [`### Operator input ${index + 1}/${snapshot.inputTexts.length}`, '', escapeTerminalControlCharacters(text)].join('\n'),
  );
  return [
    '機密情報を含む可能性があります。画面共有・端末録画・出力 capture による漏えいは防げません。',
    'これは operator-authored input を確認するためのコピーです。compiled system prompt、worker result、raw error は含みません。この画面を開いても conductor への送信や失敗 input の再実行は起きません。',
    `${snapshot.workflow} · ${snapshot.backend} · send #${snapshot.sendCount} · source: ${escapeTerminalControlCharacters(snapshot.sourceKey)}`,
    `result: ${snapshot.status} (${snapshot.failureClass}) · toolCallStarted: ${snapshot.toolCallStarted}`,
    `automatic reconnect: ${formatAutomaticReconnect(snapshot.automaticReconnect)} · automatic retries: ${snapshot.automaticRetryAttempts}`,
    `captured: ${new Date(snapshot.createdAt).toISOString()} · expires: ${new Date(snapshot.expiresAt).toISOString()}`,
    '',
    ...inputs,
    '',
    'toolCallStarted は tool 開始 callback を観測したかを示します。false でも副作用がなかった証拠にはなりません。',
    '元の入力をそのまま再入力すると、副作用が重なる可能性があります。状態を確認し、確認できた未完了分だけを新しい指示として入力してください。',
  ].join('\n');
}

function formatAutomaticReconnect(
  reconnect: ConductorRecoverySnapshotSummary['automaticReconnect'],
): string {
  if (!reconnect) return 'not attempted';
  return `${reconnect.reason} / ${reconnect.succeeded ? 'succeeded' : 'failed'}`;
}

function escapeTerminalControlCharacters(input: string): string {
  let output = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    if (character === '\n') {
      output += '\n';
    } else if (character === '\t') {
      output += '\\t';
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else if (
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      codePoint === 0x061c
    ) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else {
      output += character;
    }
  }
  return output;
}
