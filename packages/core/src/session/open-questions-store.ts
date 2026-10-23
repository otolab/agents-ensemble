import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import yaml from 'js-yaml';
import type {
  OpenQuestion,
  OpenQuestionRegistrySnapshot,
} from '../escalation/open-question.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export const OPEN_QUESTIONS_STORE_VERSION = 1;

export interface OpenQuestionsStoreDocument
  extends OpenQuestionRegistrySnapshot {
  version: typeof OPEN_QUESTIONS_STORE_VERSION;
}

export function openQuestionsStorePath(input: {
  repoRoot: string;
  conductorAgentId: string;
}): string {
  return resolveEnsemblePaths({ repoRoot: input.repoRoot }).openQuestionsPath(
    input.conductorAgentId,
  );
}

export function legacyOpenQuestionsStorePath(input: {
  repoRoot: string;
  conductorAgentId: string;
}): string {
  return resolveEnsemblePaths({
    repoRoot: input.repoRoot,
  }).legacyOpenQuestionsPath(input.conductorAgentId);
}

export async function loadOpenQuestionsStore(
  path: string,
): Promise<OpenQuestionRegistrySnapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  return parseOpenQuestionsStore(yaml.load(raw));
}

export async function saveOpenQuestionsStore(
  path: string,
  snapshot: OpenQuestionRegistrySnapshot,
): Promise<void> {
  const document = parseOpenQuestionsStore({
    version: OPEN_QUESTIONS_STORE_VERSION,
    ...snapshot,
  });
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.tmp`;
  await writeFile(
    tempPath,
    `${yaml.dump(
      {
        version: OPEN_QUESTIONS_STORE_VERSION,
        ...document,
      },
      { lineWidth: 120 },
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

function parseOpenQuestionsStore(
  value: unknown,
): OpenQuestionRegistrySnapshot {
  const record = asRecord(value, 'document');
  if (record.version !== OPEN_QUESTIONS_STORE_VERSION) {
    throw new Error(
      `Unsupported open questions YAML version: ${String(record.version)}`,
    );
  }
  if (
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0
  ) {
    throw new Error('Invalid open questions YAML: sequence');
  }
  if (!Array.isArray(record.openQuestions)) {
    throw new Error('Invalid open questions YAML: openQuestions');
  }

  const questionIds = new Set<string>();
  let highestQuestionSequence = 0;
  for (const [index, question] of record.openQuestions.entries()) {
    const { id, sequence: idSequence } = validateOpenQuestion(question, index);
    if (questionIds.has(id)) {
      throw new Error(`Invalid open questions YAML: duplicate id ${id}`);
    }
    questionIds.add(id);
    if (
      idSequence !== undefined &&
      idSequence > highestQuestionSequence
    ) {
      highestQuestionSequence = idSequence;
    }
  }
  if (highestQuestionSequence > (record.sequence as number)) {
    throw new Error(
      `Invalid open questions YAML: sequence is behind question id inq-${highestQuestionSequence}`,
    );
  }

  return {
    sequence: record.sequence as number,
    openQuestions: record.openQuestions as OpenQuestion[],
  };
}

function validateOpenQuestion(
  value: unknown,
  index: number,
): { id: string; sequence?: number } {
  const field = `openQuestions[${index}]`;
  const question = asRecord(value, field);
  requireString(question.id, `${field}.id`);
  const id = question.id as string;
  const idMatch = /^inq-([1-9]\d*)$/.exec(id);
  const idSequence = idMatch ? Number(idMatch[1]) : undefined;
  if (idSequence !== undefined && !Number.isSafeInteger(idSequence)) {
    throw new Error(`Invalid open questions YAML: ${field}.id`);
  }
  requireString(question.question, `${field}.question`);
  requireString(question.responseType, `${field}.responseType`);
  if (
    question.responseType !== 'yes_no' &&
    question.responseType !== 'text' &&
    question.responseType !== 'choice'
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.responseType`);
  }
  if (question.status !== 'open' && question.status !== 'answered') {
    throw new Error(`Invalid open questions YAML: ${field}.status`);
  }
  if (
    question.source !== 'conductor' &&
    question.source !== 'max_turns'
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.source`);
  }
  if (
    typeof question.askedAt !== 'number' ||
    !Number.isFinite(question.askedAt)
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.askedAt`);
  }

  for (const key of [
    'context',
    'answer',
    'selectedChoice',
    'sourceMessage',
    'rationale',
    'relatedPermissionId',
  ]) {
    requireOptionalString(question[key], `${field}.${key}`);
  }
  if (
    question.assent !== undefined &&
    question.assent !== 'yes' &&
    question.assent !== 'no' &&
    question.assent !== 'unclear'
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.assent`);
  }
  if (
    question.approved !== undefined &&
    typeof question.approved !== 'boolean'
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.approved`);
  }
  if (
    question.answeredAt !== undefined &&
    (typeof question.answeredAt !== 'number' ||
      !Number.isFinite(question.answeredAt))
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.answeredAt`);
  }
  if (
    question.answeredBy !== undefined &&
    question.answeredBy !== 'operator' &&
    question.answeredBy !== 'conductor'
  ) {
    throw new Error(`Invalid open questions YAML: ${field}.answeredBy`);
  }
  if (question.choices !== undefined) {
    if (!Array.isArray(question.choices)) {
      throw new Error(`Invalid open questions YAML: ${field}.choices`);
    }
    for (const [choiceIndex, choice] of question.choices.entries()) {
      const choiceRecord = asRecord(choice, `${field}.choices[${choiceIndex}]`);
      requireString(choiceRecord.id, `${field}.choices[${choiceIndex}].id`);
      requireString(
        choiceRecord.label,
        `${field}.choices[${choiceIndex}].label`,
      );
    }
  }
  return {
    id,
    ...(idSequence !== undefined ? { sequence: idSequence } : {}),
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid open questions YAML: ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(`Invalid open questions YAML: ${field}`);
  }
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid open questions YAML: ${field}`);
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
