export class EscalationUnavailableError extends Error {
  readonly code = 'ESCALATION_UNAVAILABLE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EscalationUnavailableError';
  }
}
