export type YesNoAssent = 'yes' | 'no' | 'unclear';

const AFFIRMATIVE_ANSWERS = new Set([
  'y',
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'certainly',
  'absolutely',
  'correct',
  'true',
  '1',
  'ok',
  'okay',
  'yesplease',
  'okplease',
  'okayplease',
  'はい',
  'ええ',
  'うん',
  'そう',
  'そうです',
  'いいです',
  'いいですよ',
  'いいよ',
  '大丈夫',
  '大丈夫です',
  '問題ない',
  '問題ありません',
  '了解',
  '了解です',
  '了解しました',
  '承知',
  '承知しました',
  'お願いします',
  '許可',
  '許可します',
  '許可して',
  '進めて',
  '進めてください',
  '賛成',
  '賛成です',
  '可',
  '可能',
  '承認',
  '承認します',
  'オーケー',
]);

const NEGATIVE_ANSWERS = new Set([
  'n',
  'no',
  'nope',
  'nah',
  'negative',
  'false',
  '0',
  'cancel',
  'deny',
  'dont',
  'notokay',
  'notok',
  'nothanks',
  'いいえ',
  'いや',
  'いやです',
  'だめ',
  '駄目',
  'ダメ',
  'だめです',
  '許可しない',
  '許可できない',
  '許可しません',
  '拒否',
  '拒否します',
  '不可',
  'やめて',
  'やめます',
  '中止',
  '中止します',
]);

/**
 * Parse an operator's binary assent without collapsing an unrecognized answer
 * into a denial. The original answer remains the caller's source text.
 */
export function parseYesNoAssent(answer: string): YesNoAssent {
  const normalized = normalizeAnswer(answer);
  if (NEGATIVE_ANSWERS.has(normalized)) return 'no';
  if (
    /(?:許可しません|許可できません|拒否します|やめます|中止します)/u.test(
      normalized,
    )
  ) {
    return 'no';
  }
  if (AFFIRMATIVE_ANSWERS.has(normalized)) return 'yes';

  // Japanese assent/denial phrases often include polite or explanatory suffixes.
  if (
    /^(?:いいえ|いや|だめ|駄目|ダメ|許可しない|許可しません|許可できない|拒否|不可|やめて|中止)/u.test(
      normalized,
    )
  ) {
    return 'no';
  }
  if (
    /^(?:はい|ええ|うん)(?:です|お願いします|でお願いします|進めてください|許可します)?$/u.test(
      normalized,
    )
  ) {
    return 'yes';
  }
  if (
    /^(?:yes|yeah|yep|yup|sure|certainly|absolutely|correct|true|ok|okay)(?:please|thanks|です|ですよ|だよ|お願いします)$/u.test(
      normalized,
    )
  ) {
    return 'yes';
  }
  if (
    /^(?:no|nope|nah|negative|false|cancel|deny|dont|notokay|notok|nothanks)$/u.test(
      normalized,
    )
  ) {
    return 'no';
  }

  return 'unclear';
}

export interface ChoiceOption {
  id: string;
  label: string;
}

/** Resolve an answer to an option id while leaving the answer text untouched. */
export function parseChoiceSelection(
  answer: string,
  choices: ChoiceOption[],
): string | undefined {
  const normalizedAnswer = normalizeAnswer(answer);
  if (!normalizedAnswer) return undefined;

  const matchedId = choices.find(
    (choice) => normalizeAnswer(choice.id) === normalizedAnswer,
  );
  if (matchedId) return matchedId.id;

  const matchingLabels = choices.filter(
    (choice) => normalizeAnswer(choice.label) === normalizedAnswer,
  );
  if (matchingLabels.length === 1) return matchingLabels[0]?.id;
  if (matchingLabels.length > 1) return undefined;

  // Numeric replies may select the corresponding one-based list position.
  if (/^[1-9]\d*$/u.test(normalizedAnswer)) {
    const index = Number(normalizedAnswer) - 1;
    return choices[index]?.id;
  }

  return undefined;
}

function normalizeAnswer(answer: string): string {
  return answer
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
