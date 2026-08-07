import type {
  HumanInquiryRequest,
  HumanInquiryResponse,
} from './human-inquiry.js';
import { EscalationUnavailableError } from './escalation-unavailable-error.js';

export const ESCALATION_RESPONSE_ENV = 'ENSEMBLE_ESCALATION_RESPONSE';

export function readEscalationEnvFallback(): string | undefined {
  const value = process.env[ESCALATION_RESPONSE_ENV]?.trim();
  return value || undefined;
}

export function parseEnvInquiryResponse(
  raw: string,
  responseType: HumanInquiryRequest['responseType'],
): HumanInquiryResponse {
  const answer = raw.trim();
  if (responseType === 'yes_no') {
    const normalized = answer.toLowerCase();
    const approved =
      normalized === 'y' ||
      normalized === 'yes' ||
      normalized === 'true' ||
      normalized === '1';
    return { answer, approved };
  }
  return { answer };
}

export function resolveHumanInquiryFromEnv(
  request: HumanInquiryRequest,
): HumanInquiryResponse | undefined {
  const fallback = readEscalationEnvFallback();
  if (fallback === undefined) return undefined;
  return parseEnvInquiryResponse(fallback, request.responseType);
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
