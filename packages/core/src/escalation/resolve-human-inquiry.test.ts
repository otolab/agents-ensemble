import { afterEach, describe, expect, it } from 'vitest';
import {
  ESCALATION_RESPONSE_ENV,
  parseEnvInquiryResponse,
  readEscalationEnvFallback,
  resolveHumanInquiryFromEnv,
} from './resolve-human-inquiry.js';

describe('resolveHumanInquiryFromEnv', () => {
  const original = process.env[ESCALATION_RESPONSE_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ESCALATION_RESPONSE_ENV];
    } else {
      process.env[ESCALATION_RESPONSE_ENV] = original;
    }
  });

  it('reads yes from env for yes_no', () => {
    process.env[ESCALATION_RESPONSE_ENV] = 'yes';
    const response = resolveHumanInquiryFromEnv({
      kind: 'escalation',
      question: 'Continue?',
      responseType: 'yes_no',
    });
    expect(response).toEqual({ answer: 'yes', approved: true });
  });

  it('reads free text from env', () => {
    process.env[ESCALATION_RESPONSE_ENV] = 'dispatch reviewer next';
    const response = resolveHumanInquiryFromEnv({
      kind: 'escalation',
      question: 'What next?',
      responseType: 'text',
    });
    expect(response).toEqual({ answer: 'dispatch reviewer next' });
  });

  it('returns undefined when env is unset', () => {
    delete process.env[ESCALATION_RESPONSE_ENV];
    expect(readEscalationEnvFallback()).toBeUndefined();
    expect(
      resolveHumanInquiryFromEnv({
        kind: 'escalation',
        question: 'q',
        responseType: 'text',
      }),
    ).toBeUndefined();
  });
});

describe('parseEnvInquiryResponse', () => {
  it('treats n as not approved', () => {
    expect(parseEnvInquiryResponse('n', 'yes_no')).toEqual({
      answer: 'n',
      approved: false,
    });
  });
});
