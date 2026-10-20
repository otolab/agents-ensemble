import type { OpenQuestion, OpenQuestionRegistry } from './open-question.js';
import { parseChoiceSelection, parseYesNoAssent } from './yes-no-assent.js';

export interface RecordOpenQuestionAnswerInput {
  id: string;
  answer: string;
  answeredAt?: number;
  selectedChoice?: string;
  /** @deprecated Approval is derived from assent for permission-linked yes_no questions. */
  approved?: boolean;
  answeredBy: 'operator' | 'conductor';
  sourceMessage?: string;
  rationale?: string;
}

export function recordOpenQuestionAnswer(
  registry: OpenQuestionRegistry,
  input: RecordOpenQuestionAnswerInput,
): OpenQuestion | undefined {
  const entry = registry.get(input.id);
  if (!entry || entry.status !== 'open') return undefined;

  const assent =
    entry.responseType === 'yes_no'
      ? parseYesNoAssent(input.answer)
      : undefined;
  const selectedChoice =
    entry.responseType === 'choice'
      ? resolveSelectedChoice(
          input.selectedChoice,
          input.answer,
          entry.choices ?? [],
        )
      : undefined;
  return registry.answer(input.id, {
    answer: input.answer,
    answeredAt: input.answeredAt,
    assent,
    selectedChoice,
    answeredBy: input.answeredBy,
    sourceMessage: input.sourceMessage,
    rationale: input.rationale,
  });
}

function resolveSelectedChoice(
  selectedChoice: string | undefined,
  answer: string,
  choices: NonNullable<OpenQuestion['choices']>,
): string | undefined {
  const explicitChoices = choices.filter(
    (choice) => choice.id === selectedChoice?.trim(),
  );
  if (explicitChoices.length === 1) return explicitChoices[0]?.id;
  return parseChoiceSelection(answer, choices);
}
