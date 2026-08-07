export type HumanInquiryKind = 'permission' | 'escalation';

export type HumanInquiryResponseType = 'yes_no' | 'text';

export interface HumanInquiryRequest {
  kind: HumanInquiryKind;
  question: string;
  responseType: HumanInquiryResponseType;
  context?: string;
  sessionId?: string;
  toolName?: string;
}

export interface HumanInquiryResponse {
  answer: string;
  approved?: boolean;
}

export type HumanInquiryHandler = (
  request: HumanInquiryRequest,
) => HumanInquiryResponse | Promise<HumanInquiryResponse>;

export interface EscalationRecord {
  question: string;
  responseType: HumanInquiryResponseType;
  context?: string;
  answer: string;
  approved?: boolean;
}
