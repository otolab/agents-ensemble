import type { SessionObservationSnapshot, SessionResumeStore } from '@agents-ensemble/core/operator-runtime';
import type { SessionCursor } from './types.js';
import { hash } from './operator-watch-hash.js';

export function collectReports(
  resumeStore: SessionResumeStore,
  observation: SessionObservationSnapshot,
  previous: SessionCursor | undefined,
  source: 'uds' | 'resume_store',
): Array<{ reportType: 'session_state' | 'open_question'; text: string }> {
  const reports: Array<{
    reportType: 'session_state' | 'open_question';
    text: string;
  }> = [];
  const issue = `${resumeStore.issueUrl} (${resumeStore.conductorAgentId})`;
  const observationSource =
    source === 'uds' ? '稼働中 UDS' : '保存済み SessionResumeStore / YAML';

  const currentQuestionIds = new Set(
    observation.openQuestions.map((question) => question.id),
  );
  const questionChanges: Array<{
    askedAt: number;
    id: string;
    kind: 'new' | 'answered' | 'disappeared';
    question: string;
    details?: SessionObservationSnapshot['openQuestions'][number];
    previousStatusUnknown?: boolean;
  }> = [];

  for (const question of observation.openQuestions) {
    const previousQuestion = previous?.questionSnapshots?.[question.id];
    const wasKnown = previous?.questionFingerprints[question.id] !== undefined;
    if (previous && !wasKnown && question.status === 'open') {
      questionChanges.push({
        askedAt: question.askedAt,
        id: question.id,
        kind: 'new',
        question: question.question,
        details: question,
      });
    } else if (
      question.status === 'answered' &&
      (previousQuestion?.status === 'open' ||
        (!previousQuestion &&
          previous?.questionFingerprints[question.id] ===
            fingerprintAsOpen(question)))
    ) {
      questionChanges.push({
        askedAt: question.askedAt,
        id: question.id,
        kind: 'answered',
        question: question.question,
        details: question,
      });
    }
  }

  for (const id of Object.keys(previous?.questionFingerprints ?? {})) {
    if (currentQuestionIds.has(id)) continue;
    const question = previous?.questionSnapshots?.[id];
    if (question && question.status !== 'open') continue;
    questionChanges.push({
      askedAt: question?.askedAt ?? Number.MAX_SAFE_INTEGER,
      id,
      kind: 'disappeared',
      question:
        question?.question ??
        '前回の質問文は旧 cursor に保存されていません',
      ...(!question ? { previousStatusUnknown: true } : {}),
    });
  }

  questionChanges.sort(
    (left, right) =>
      compareQuestionIds(left.id, right.id) || left.askedAt - right.askedAt,
  );
  for (const change of questionChanges) {
    if (change.kind === 'new') {
      reports.push({
        reportType: 'open_question',
        text: [
          `対象: ${issue} / 観測元: ${observationSource}`,
          `新規追加: ${change.id} / ${change.details!.responseType}`,
          `質問: ${formatQuestionSummary(change.question)}`,
          ...(change.details?.context
            ? [`context: ${formatQuestionSummary(change.details.context)}`]
            : []),
        ].join('\n'),
      });
      continue;
    }

    if (change.kind === 'disappeared') {
      reports.push({
        reportType: 'open_question',
        text: [
          `対象: ${issue} / 観測元: ${observationSource}`,
          `一覧から消失: ${change.id}`,
          `質問: ${formatQuestionSummary(change.question)}`,
          ...(change.previousStatusUnknown
            ? ['前回の status: 旧 cursor のため不明']
            : []),
          '回答・回答者: 今回の snapshot では確認できません',
        ].join('\n'),
      });
      continue;
    }

    const question = change.details!;
    reports.push({
      reportType: 'open_question',
      text: [
        `対象: ${issue} / 観測元: ${observationSource}`,
        `解決: ${question.id}`,
        `質問: ${formatQuestionSummary(question.question)}`,
        ...(question.answer
          ? [`回答: ${formatQuestionSummary(question.answer)}`]
          : []),
        ...(question.assent ? [`賛否: ${question.assent}`] : []),
        ...(question.selectedChoice
          ? [`選択肢: ${formatQuestionSummary(question.selectedChoice)}`]
          : []),
        ...(question.answer || question.assent || question.selectedChoice
          ? []
          : ['回答内容: snapshot に記録されていません']),
        ...(question.answeredBy
          ? [`answeredBy: ${question.answeredBy}`]
          : []),
        ...(question.answeredAt !== undefined
          ? [`answeredAt: ${formatQuestionTimestamp(question.answeredAt)}`]
          : []),
      ].join('\n'),
    });
  }

  const statusEntries = observation.sessionState
    ? [...observation.sessionState.history, observation.sessionState.current]
    : [];
  const changedStatuses = statusEntries.filter((status) => {
    const fingerprint = hash(status);
    return previous?.statusFingerprints[String(status.reportedAt)] !== fingerprint;
  });
  const firstPoll = !previous;
  const selectedStatuses = firstPoll ? changedStatuses.slice(-1) : changedStatuses;
  for (const status of selectedStatuses) {
    reports.push({
      reportType: 'session_state',
      text: [
        `対象: ${issue} / 観測元: ${observationSource}`,
        `状態 (${new Date(status.reportedAt).toISOString()}): ${status.statusLine}`,
      ].join('\n'),
    });
  }
  return reports;
}

export function cursorFor(
  observation: SessionObservationSnapshot,
  checkedAt?: number,
  source?: 'uds' | 'resume_store',
  previous?: SessionCursor,
): SessionCursor {
  const questionFingerprints: Record<string, string> = {};
  const questionSnapshots: NonNullable<SessionCursor['questionSnapshots']> = {};
  for (const question of observation.openQuestions) {
    questionFingerprints[question.id] = hash(question);
    questionSnapshots[question.id] = {
      question: question.question,
      status: question.status,
      askedAt: question.askedAt,
    };
  }
  const statusFingerprints: Record<string, string> = {};
  if (observation.sessionState) {
    for (const status of [
      ...observation.sessionState.history,
      observation.sessionState.current,
    ]) {
      statusFingerprints[String(status.reportedAt)] = hash(status);
    }
  }
  return {
    sequence: observation.sequence,
    questionFingerprints,
    questionSnapshots,
    statusFingerprints,
    ...(checkedAt !== undefined && source !== undefined
      ? {
          questionCountObservation: {
            metric: 'unanswered_open_questions',
            current: {
              count: observation.openQuestions.filter(
                (question) => question.status === 'open',
              ).length,
              checkedAt,
              source,
            },
            ...(previous?.questionCountObservation
              ? {
                  previous:
                    previous.questionCountObservation.current,
                }
              : {}),
          },
        }
      : previous?.questionCountObservation
        ? {
            questionCountObservation:
              previous.questionCountObservation,
          }
        : {}),
  };
}

function compareQuestionIds(left: string, right: string): number {
  const leftSequence = /^inq-(\d+)$/.exec(left)?.[1];
  const rightSequence = /^inq-(\d+)$/.exec(right)?.[1];
  if (leftSequence && rightSequence) {
    return Number(leftSequence) - Number(rightSequence);
  }
  return left.localeCompare(right);
}

function fingerprintAsOpen(
  question: SessionObservationSnapshot['openQuestions'][number],
): string {
  const openQuestion = { ...question, status: 'open' as const };
  delete openQuestion.answer;
  delete openQuestion.assent;
  delete openQuestion.selectedChoice;
  delete openQuestion.approved;
  delete openQuestion.answeredAt;
  delete openQuestion.answeredBy;
  delete openQuestion.sourceMessage;
  delete openQuestion.rationale;
  return hash(openQuestion);
}

function formatQuestionSummary(value: string, maxLength = 240): string {
  const summary = value.replace(/\s+/g, ' ').trim();
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatQuestionTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
