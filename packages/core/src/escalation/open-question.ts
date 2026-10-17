import type { ChoiceOption, HumanInquiryResponseType } from './human-inquiry.js';
import type { YesNoAssent } from './yes-no-assent.js';

export type OpenQuestionStatus = 'open' | 'answered';

export type OpenQuestionAnsweredBy = 'operator' | 'conductor';

export type OpenQuestionSource = 'conductor' | 'max_turns';

export interface OpenQuestion {
  id: string;
  question: string;
  responseType: HumanInquiryResponseType;
  choices?: ChoiceOption[];
  context?: string;
  source: OpenQuestionSource;
  status: OpenQuestionStatus;
  askedAt: number;
  answer?: string;
  assent?: YesNoAssent;
  selectedChoice?: string;
  approved?: boolean;
  answeredAt?: number;
  answeredBy?: OpenQuestionAnsweredBy;
  sourceMessage?: string;
  rationale?: string;
  relatedPermissionId?: string;
}

export interface EnqueueOpenQuestionInput {
  question: string;
  responseType: HumanInquiryResponseType;
  choices?: ChoiceOption[];
  context?: string;
  relatedPermissionId?: string;
  source?: OpenQuestionSource;
}

export interface AnswerOpenQuestionInput {
  answer: string;
  assent?: YesNoAssent;
  selectedChoice?: string;
  /** @deprecated Approval is derived from assent for permission-linked yes_no questions. */
  approved?: boolean;
  answeredBy: OpenQuestionAnsweredBy;
  sourceMessage?: string;
  rationale?: string;
}

/** ask_human で登録する未回答 / 回答済み質問。compaction に強いセッション状態。 */
export class OpenQuestionRegistry {
  private sequence = 0;
  private readonly entries = new Map<string, OpenQuestion>();

  enqueue(input: EnqueueOpenQuestionInput): OpenQuestion {
    const id = `inq-${++this.sequence}`;
    const entry: OpenQuestion = {
      id,
      question: input.question,
      responseType: input.responseType,
      ...(input.choices
        ? { choices: input.choices.map((choice) => ({ ...choice })) }
        : {}),
      context: input.context,
      relatedPermissionId: input.relatedPermissionId,
      source: input.source ?? 'conductor',
      status: 'open',
      askedAt: Date.now(),
    };
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): OpenQuestion | undefined {
    return this.entries.get(id);
  }

  answer(id: string, input: AnswerOpenQuestionInput): OpenQuestion | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'open') return undefined;

    const matchingChoices =
      entry.responseType === 'choice'
        ? entry.choices?.filter((choice) => choice.id === input.selectedChoice)
        : undefined;
    const selectedChoice =
      matchingChoices?.length === 1 ? matchingChoices[0]?.id : undefined;

    const updated: OpenQuestion = {
      ...entry,
      status: 'answered',
      answer: input.answer,
      assent: entry.responseType === 'yes_no' ? input.assent : undefined,
      selectedChoice,
      approved:
        entry.responseType === 'yes_no' &&
        entry.relatedPermissionId &&
        input.assent !== undefined &&
        input.assent !== 'unclear'
          ? input.assent === 'yes'
          : undefined,
      answeredAt: Date.now(),
      answeredBy: input.answeredBy,
      sourceMessage: input.sourceMessage,
      rationale: input.rationale,
    };
    this.entries.set(id, updated);
    return updated;
  }

  list(): OpenQuestion[] {
    return [...this.entries.values()];
  }

  listOpen(): OpenQuestion[] {
    return this.list().filter((entry) => entry.status === 'open');
  }

  listAnswered(): OpenQuestion[] {
    return this.list().filter((entry) => entry.status === 'answered');
  }

  get openCount(): number {
    return this.listOpen().length;
  }

  snapshot(): OpenQuestionRegistrySnapshot {
    return {
      sequence: this.sequence,
      openQuestions: this.list(),
    };
  }

  restore(snapshot: OpenQuestionRegistrySnapshot): void {
    this.sequence = snapshot.sequence;
    this.entries.clear();
    for (const entry of snapshot.openQuestions) {
      this.entries.set(entry.id, entry);
    }
  }
}

export interface OpenQuestionRegistrySnapshot {
  sequence: number;
  openQuestions: OpenQuestion[];
}
