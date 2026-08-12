import { existsSync } from 'node:fs';
import { Cursor, getDefaultSdkAuthPath } from '@cursor/sdk';
import type { SdkAuthStatus, SdkLoginResult } from '@cursor/sdk';
import type { ConductorSendResult } from './conductor-agent.js';

/**
 * SDK の認証解決順に沿ったヒント。
 * `agent login` は ACP（worker）向けで、SDK（conductor）には自動では渡らない。
 */
export const CONDUCTOR_AUTH_HINT =
  'Conductor の認証が見つかりません。`ensemble auth logout` の後 `ensemble auth login` を実行するか、`export CURSOR_API_KEY=...` を設定してください。' +
  '（`agent login` だけでは conductor には足りません。worker の ACP には `agent login` で足ります。）';

/** RunResult.error 等の message が conductor 認証失敗か判定する。 */
export function isConductorAuthError(message: string): boolean {
  return /authentication error|not logged in|invalid api key|unauthenticated|try logging out/i.test(
    message,
  );
}

/**
 * SDK idle / stale 接続で message 欠落の bare `status: "error"` が返る既知ケース。
 * 誤検知を避けるため、明示的な error message / result が無いときのみ true。
 */
export function isBareConductorSendAuthError(result: ConductorSendResult): boolean {
  if (result.status !== 'error') {
    return false;
  }
  if (result.error?.message?.trim()) {
    return false;
  }
  if (result.result?.trim()) {
    return false;
  }
  const code = result.error?.code?.trim();
  if (code && !/unauthenticated|auth/i.test(code)) {
    return false;
  }
  return true;
}

/** send 結果が auth-like（明示 message または保守的 bare error）か。 */
export function isConductorSendAuthError(result: ConductorSendResult): boolean {
  if (result.status !== 'error') {
    return false;
  }
  if (isConductorAuthError(result.error?.message ?? '')) {
    return true;
  }
  return isBareConductorSendAuthError(result);
}

/** auth エラー時に stderr へ出す短い復旧手順。 */
export function formatConductorAuthRecoveryHint(agentId?: string): string {
  const resume = agentId ? `--resume ${agentId}` : '--resume <agentId>';

  if (process.env.CURSOR_API_KEY) {
    return (
      `[auth] 認証エラー。unset CURSOR_API_KEY または Dashboard で key をローテーション後、` +
      `ensemble issue ... ${resume}（agentId は終了 JSON 参照）`
    );
  }

  return (
    `[auth] 認証エラー。ensemble auth logout → ensemble auth login → ` +
    `ensemble issue ... ${resume}（または --continue。agentId は終了 JSON 参照）`
  );
}

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

/** SDK stored login または CURSOR_API_KEY があるか（同期チェック）。 */
export function hasConductorAuth(): boolean {
  if (process.env.CURSOR_API_KEY) return true;
  return existsSync(getDefaultSdkAuthPath());
}

export async function getConductorAuthStatus(): Promise<SdkAuthStatus> {
  return Cursor.auth.status();
}

export async function loginConductor(): Promise<SdkLoginResult> {
  return Cursor.auth.login();
}

export async function logoutConductor(): Promise<void> {
  return Cursor.auth.logout();
}
