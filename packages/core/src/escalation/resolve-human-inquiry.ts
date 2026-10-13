import type {
  HumanInquiryRequest,
  HumanInquiryResponse,
} from './human-inquiry.js';
import { EscalationUnavailableError } from './escalation-unavailable-error.js';
import { parseChoiceSelection, parseYesNoAssent } from './yes-no-assent.js';

export const ESCALATION_RESPONSE_ENV = 'ENSEMBLE_ESCALATION_RESPONSE';

export function readEscalationEnvFallback(): string | undefined {
  const value = process.env[ESCALATION_RESPONSE_ENV]?.trim();
  return value || undefined;
}

export function parseEnvInquiryResponse(
  raw: string,
  responseType: HumanInquiryRequest['responseType'],
  choices?: HumanInquiryRequest['choices'],
): HumanInquiryResponse {
  return parseHumanInquiryAnswer(raw, {
    kind: 'escalation',
    question: '',
    responseType,
    choices,
  });
}

/** Parse a TTY or environment answer while preserving its text. */
export function parseHumanInquiryAnswer(
  raw: string,
  request: HumanInquiryRequest,
): HumanInquiryResponse {
  const answer = raw.trim();
  if (request.responseType === 'yes_no') {
    const assent = parseYesNoAssent(answer);
    return {
      answer,
      assent,
      ...(request.kind === 'permission' && assent !== 'unclear'
        ? { approved: assent === 'yes' }
        : {}),
    };
  }
  if (request.responseType === 'choice') {
    const selectedChoice = parseChoiceSelection(answer, request.choices ?? []);
    return {
      answer,
      ...(selectedChoice === undefined ? {} : { selectedChoice }),
    };
  }
  return { answer };
}

export function resolveHumanInquiryFromEnv(
  request: HumanInquiryRequest,
): HumanInquiryResponse | undefined {
  const fallback = readEscalationEnvFallback();
  if (fallback === undefined) return undefined;
  return parseHumanInquiryAnswer(fallback, request);
}

export function escalationUnavailableMessage(): string {
  return (
    'Human inquiry is unavailable in non-interactive mode. ' +
    `Set ${ESCALATION_RESPONSE_ENV} or run ensemble issue in a TTY.`
  );
}

export function createEnvFallbackHumanInquiryHandler(): (
  request: HumanInquiryRequest,
) => HumanInquiryResponse {
  return (request) => {
    const fromEnv = resolveHumanInquiryFromEnv(request);
    if (fromEnv) return fromEnv;
    throw new EscalationUnavailableError(escalationUnavailableMessage());
  };
}
