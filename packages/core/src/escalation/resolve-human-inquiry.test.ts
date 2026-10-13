import { afterEach, describe, expect, it } from 'vitest';
import {
  ESCALATION_RESPONSE_ENV,
  parseEnvInquiryResponse,
  parseHumanInquiryAnswer,
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
    expect(response).toEqual({ answer: 'yes', assent: 'yes' });
  });

  it.each([
    ['yes', 'yes', true],
    ['no', 'no', false],
    ['okです。', 'yes', true],
    ['いいえ', 'no', false],
    ['maybe', 'unclear', undefined],
    ['どちらとも言えません', 'unclear', undefined],
  ] as const)(
    'parses permission answer %j and derives approved only for clear assent',
    (answer, assent, approved) => {
      process.env[ESCALATION_RESPONSE_ENV] = answer;
      expect(
        resolveHumanInquiryFromEnv({
          kind: 'permission',
          question: 'Allow?',
          responseType: 'yes_no',
        }),
      ).toEqual({
        answer,
        assent,
        ...(approved === undefined ? {} : { approved }),
      });
    },
  );

  it('does not add approved to non-permission yes_no answers', () => {
    process.env[ESCALATION_RESPONSE_ENV] = 'yes';
    expect(
      resolveHumanInquiryFromEnv({
        kind: 'escalation',
        question: 'Continue?',
        responseType: 'yes_no',
      }),
    ).toEqual({ answer: 'yes', assent: 'yes' });
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

  it('preserves free-form yes_no answer text with an unclear assent', () => {
    expect(
      parseEnvInquiryResponse('I would like to review it first.', 'yes_no'),
    ).toEqual({
      answer: 'I would like to review it first.',
      assent: 'unclear',
    });
  });

  it('parses a choice selection by option id', () => {
    expect(
      parseEnvInquiryResponse('B', 'choice', [
        { id: 'A', label: 'Ship now' },
        { id: 'B', label: 'Wait for review' },
      ]),
    ).toEqual({ answer: 'B', selectedChoice: 'B' });
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
  it('records n as negative assent without a permission context', () => {
    expect(parseEnvInquiryResponse('n', 'yes_no')).toEqual({
      answer: 'n',
      assent: 'no',
    });
  });
});

describe('parseHumanInquiryAnswer', () => {
  it('derives permission approval from yes/no assent and leaves unclear unset', () => {
    const request = {
      kind: 'permission' as const,
      question: 'Allow?',
      responseType: 'yes_no' as const,
    };

    expect(parseHumanInquiryAnswer(' yes ', request)).toEqual({
      answer: 'yes',
      assent: 'yes',
      approved: true,
    });
    expect(parseHumanInquiryAnswer('not sure', request)).toEqual({
      answer: 'not sure',
      assent: 'unclear',
    });
  });
});
