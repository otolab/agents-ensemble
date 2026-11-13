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
import { escapeTerminalControlCharacters } from '../representation/escape-terminal-control-characters.js';
import type {
  CursorBootstrapAssumption,
  CursorBootstrapStatus,
} from './cursor-bootstrap-state.js';

export interface RecoveryInboxCommandApi {
  listRecoverySnapshots?: () => ConductorRecoverySnapshotSummary[];
  getRecoverySnapshot?: (
    recoveryId: string,
  ) => ConductorRecoverySnapshot | undefined;
  clearRecoverySnapshot?: (recoveryId: string) => boolean;
  continueAfterRecovery?: () => boolean;
  recoveryAttentionAttemptId?: () => string | undefined;
  getCursorBootstrapStatus?: () => CursorBootstrapStatus;
  resolveCursorBootstrapUnknown?: (
    assumption: CursorBootstrapAssumption,
  ) => boolean;
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

  if (command === 'bootstrap') {
    const status = api?.getCursorBootstrapStatus?.();
    if (recoveryId === undefined && extraArgs.length === 0) {
      return {
        handled: true,
        inspection: {
          title: 'Cursor bootstrap',
          text: formatCursorBootstrapStatus(status),
        },
      };
    }

    const assumption =
      recoveryId === 'assume-complete' ||
      recoveryId === 'assume-incomplete'
        ? recoveryId
        : undefined;
    if (!assumption || extraArgs.length > 0) {
      return {
        handled: true,
        inspection: {
          title: 'Cursor bootstrap',
          text: [
            '使い方:',
            '  /recovery bootstrap',
            '  /recovery bootstrap assume-complete',
            '  /recovery bootstrap assume-incomplete',
            '',
            'この判断は、状態を記録していない旧 Cursor session でのみ必要です。',
          ].join('\n'),
        },
      };
    }

    if (!options.canDisplaySensitiveContent) {
      return {
        handled: true,
        inspection: {
          title: 'Cursor bootstrap',
          text:
            '旧 Cursor session の bootstrap 状態は対話 TTY でのみ選択できます。この実行環境では dispatch を開始しません。',
        },
      };
    }
    if (!status) {
      return {
        handled: true,
        inspection: {
          title: 'Cursor bootstrap',
          text: 'この session では旧 Cursor bootstrap の判断は必要ありません。',
        },
      };
    }
    if (status !== 'unknown') {
      return {
        handled: true,
        inspection: {
          title: 'Cursor bootstrap',
          text: formatCursorBootstrapStatus(status),
        },
      };
    }

    const accepted =
      api?.resolveCursorBootstrapUnknown?.(assumption) ?? false;
    return {
      handled: true,
      inspection: {
        title: 'Cursor bootstrap',
        text: accepted
          ? [
              `選択 ${assumption} を受け付けました。判断を SessionResumeStore に保存しています。`,
              '保存が完了するまで queue の dispatch は停止します。',
              assumption === 'assume-complete'
                ? '保存後は compiled prompt を再送しません。旧 session に文脈がなかった可能性は残ります。'
                : '保存後は失敗 input を replay せず、次に選ばれる新しい event に compiled prompt を添えます。',
            ].join(' ')
          : 'bootstrap 状態は unknown ではなくなりました。/recovery bootstrap で現在の状態を確認してください。',
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
        '  /recovery bootstrap [assume-complete|assume-incomplete]',
        '',
        'continue は現在の send 結果を確認した後に使ってください。失敗した入力は自動再送されません。',
      ].join('\n'),
    },
  };
}

function formatCursorBootstrapStatus(
  status: CursorBootstrapStatus | undefined,
): string {
  switch (status) {
    case 'unknown':
      return [
        '旧 Cursor session の compiled prompt が provider に届いたか判定できません。dispatch は選択まで停止しています。',
        '/recovery bootstrap assume-complete は prompt を再送しませんが、文脈が欠けている可能性を残します。',
        '/recovery bootstrap assume-incomplete は次の新しい event に prompt を添えます。provider transcript に prompt が重複する可能性があります。',
        'どちらも失敗 input や旧 queue を復元・再送しません。',
      ].join('\n');
    case 'saving':
      return 'bootstrap の選択を SessionResumeStore に保存中です。完了するまで dispatch は停止しています。';
    case 'complete':
      return 'Cursor bootstrap は完了扱いとして記録されています。compiled prompt は追加送信しません。';
    case 'incomplete':
      return 'Cursor bootstrap の完了は未確認です。次に選ばれる新しい event に compiled prompt を添えて送ります。';
    default:
      return 'この session では旧 Cursor bootstrap の判断は必要ありません。';
  }
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
        `  events: ${snapshot.eventTypes.map((eventType) => escapeTerminalControlCharacters(eventType)).join(', ')} · operator inputs: ${snapshot.inputCount}`,
        `  result: ${escapeTerminalControlCharacters(snapshot.status)} (${snapshot.failureClass}) · toolCallStarted: ${snapshot.toolCallStarted}`,
        `  automatic reconnect: ${formatAutomaticReconnect(snapshot.automaticReconnect)} · automatic retries: ${snapshot.automaticRetryAttempts}`,
        `  content: ${snapshot.contentBytes} UTF-8 bytes · expires: ${new Date(snapshot.expiresAt).toISOString()}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function formatRecoverySnapshot(snapshot: ConductorRecoverySnapshot): string {
  const inputs = snapshot.inputTexts.map((text, index) =>
    [
      `### Operator input ${index + 1}/${snapshot.inputTexts.length}`,
      '',
      escapeTerminalControlCharacters(text, { preserveNewlines: true }),
    ].join('\n'),
  );
  return [
    '機密情報を含む可能性があります。画面共有・端末録画・出力 capture による漏えいは防げません。',
    'これは operator-authored input を確認するためのコピーです。compiled system prompt、worker result、raw error は含みません。この画面を開いても conductor への送信や失敗 input の再実行は起きません。',
    `${snapshot.workflow} · ${snapshot.backend} · send #${snapshot.sendCount} · source: ${escapeTerminalControlCharacters(snapshot.sourceKey)}`,
    `result: ${escapeTerminalControlCharacters(snapshot.status)} (${snapshot.failureClass}) · toolCallStarted: ${snapshot.toolCallStarted}`,
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
