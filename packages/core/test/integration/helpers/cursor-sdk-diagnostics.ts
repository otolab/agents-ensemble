interface CursorSdkErrorDetail {
  code?: string;
  message?: string;
}

const KNOWN_ERROR_CODES = new Set([
  'auth',
  'unauthorized',
  'forbidden',
  'invalid_request',
  'model_not_found',
  'rate_limit',
  'timeout',
  'network_error',
  'internal_server_error',
  '401',
  '403',
  '404',
  '408',
  '429',
  '500',
  '502',
  '503',
  '504',
]);

/**
 * Keep failed live Cursor integration assertions useful without printing raw
 * provider messages, which may contain credentials or request details.
 */
export function formatCursorSdkFailureDiagnostic(input: {
  status: string;
  error?: CursorSdkErrorDetail;
}): string {
  const status = new Set([
    'finished',
    'completed',
    'running',
    'error',
    'cancelled',
  ]).has(input.status)
    ? input.status
    : 'other';
  const errorCode = input.error?.code?.toLowerCase();
  const safeErrorCode =
    errorCode && KNOWN_ERROR_CODES.has(errorCode) ? errorCode : 'omitted';
  const errorClass = classifyCursorSdkError(input.error);

  return [
    `Cursor SDK returned status=${status}`,
    `errorCode=${safeErrorCode}`,
    `errorClass=${errorClass}`,
    '(raw provider message omitted)',
  ].join('; ');
}

function classifyCursorSdkError(
  error: CursorSdkErrorDetail | undefined,
): string {
  if (!error) return 'none';
  const signal = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  if (/auth|unauthori[sz]ed|forbidden|\b401\b|\b403\b|api key/.test(signal)) {
    return 'authentication';
  }
  if (/rate.?limit|\b429\b/.test(signal)) return 'rate-limit';
  if (/quota|billing|payment/.test(signal)) return 'quota';
  if (/model.*(?:not found|invalid|unavailable)|unknown model/.test(signal)) {
    return 'model';
  }
  if (
    /timeout|timed out|network|transport|socket|connection|econn|etimedout/.test(
      signal,
    )
  ) {
    return 'transport';
  }
  return error.code || error.message ? 'provider-error' : 'none';
}
