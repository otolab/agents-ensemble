import type { ChoiceOption, YesNoAssent } from './yes-no-assent.js';

export type HumanInquiryKind = 'permission' | 'escalation';

export type HumanInquiryResponseType = 'yes_no' | 'text' | 'choice';

export type { ChoiceOption, YesNoAssent } from './yes-no-assent.js';

export interface HumanInquiryRequest {
  kind: HumanInquiryKind;
  question: string;
  responseType: HumanInquiryResponseType;
  choices?: ChoiceOption[];
  context?: string;
  sessionId?: string;
  toolName?: string;
}

export interface HumanInquiryResponse {
  answer: string;
  assent?: YesNoAssent;
  selectedChoice?: string;
  approved?: boolean;
}

export type HumanInquiryHandler = (
  request: HumanInquiryRequest,
) => HumanInquiryResponse | Promise<HumanInquiryResponse>;

export interface EscalationRecord {
  question: string;
  responseType: HumanInquiryResponseType;
  choices?: ChoiceOption[];
  context?: string;
  answer: string;
  assent?: YesNoAssent;
  selectedChoice?: string;
  approved?: boolean;
}
