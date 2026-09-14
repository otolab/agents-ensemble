export const OPERATOR_MESSAGE_ENV = 'ENSEMBLE_OPERATOR_MESSAGE';

/** CLI の variadic 引数、または単一文字列をオペレータメッセージへ正規化する。 */
export function normalizeInitialOperatorMessage(
  message: string | readonly string[] | undefined,
): string | undefined {
  const joined = typeof message === 'string' ? message : message?.join(' ');
  const trimmed = joined?.trim();
  return trimmed || undefined;
}

/** CLI と環境変数の初回オペレータメッセージを解決する。 */
export function resolveInitialOperatorMessage(
  cliMessage?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromCli = normalizeInitialOperatorMessage(cliMessage);
  const fromEnv = normalizeInitialOperatorMessage(env[OPERATOR_MESSAGE_ENV]);

  if (fromCli && fromEnv) {
    throw new Error(
      `Cannot use a CLI operator message together with ${OPERATOR_MESSAGE_ENV}; provide only one.`,
    );
  }

  return fromCli ?? fromEnv;
}
