import { Cursor } from '@cursor/sdk';
import type { SdkAuthStatus, SdkLoginResult } from '@cursor/sdk';

/**
 * SDK の認証解決順に沿ったヒント。
 * `agent login` は ACP（worker）向けで、SDK（conductor）には自動では渡らない。
 */
export const CONDUCTOR_AUTH_HINT =
  'Conductor の認証が見つかりません。`ensemble auth login` を一度実行するか、`export CURSOR_API_KEY=...` を設定してください。' +
  '（`agent login` だけでは conductor には足りません。worker の ACP には `agent login` で足ります。）';

/**
 * Conductor 用 API key を明示指定のみ解決する。
 * 未指定時は `Agent.create` に渡さず、SDK の stored login フォールバックに任せる。
 */
export function resolveConductorApiKey(explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  if (process.env.CURSOR_API_KEY !== undefined) {
    return process.env.CURSOR_API_KEY;
  }
  return undefined;
}

export async function getConductorAuthStatus(): Promise<SdkAuthStatus> {
  return Cursor.auth.status();
}

export async function loginConductor(): Promise<SdkLoginResult> {
  return Cursor.auth.login();
}
