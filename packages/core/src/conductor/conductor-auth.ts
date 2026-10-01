import { existsSync } from 'node:fs';
import { Cursor, getDefaultSdkAuthPath } from '@cursor/sdk';
import type { SdkAuthStatus, SdkLoginResult } from '@cursor/sdk';
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai/compat';
import {
  getPiConductorAuthStatus,
  hasPiConductorAuth,
  loginPiConductor,
  logoutPiConductor,
  formatPiProviderEnvHint,
  type PiConductorAuthOptions,
  type PiConductorAuthStatus,
  type PiConductorLoginResult,
  type PiConductorLogoutResult,
} from './conductor-pi-auth.js';
import { resolveConductorBackendSetting } from '../config/resolve-settings.js';
import type { ConductorBackend, EnsembleConfig } from '../config/types.js';
import type { ConductorSendResult } from './conductor-agent.js';

/**
 * SDK の認証解決順に沿ったヒント。
 * `agent login` は ACP（worker）向けで、SDK（conductor）には自動では渡らない。
 */
export const CONDUCTOR_AUTH_HINT =
  'Conductor の認証が見つかりません。`ensemble auth logout` の後 `ensemble auth login` を実行するか、`export CURSOR_API_KEY=...` を設定してください。' +
    '（`agent login` だけでは conductor には足りません。worker の ACP には `agent login` で足ります。）';

export interface ConductorAuthOptions {
  /** Explicit backend selection. If omitted, profile/config resolution is used. */
  backend?: ConductorBackend;
  profile?: { conductor?: { backend?: ConductorBackend } };
  config?: EnsembleConfig;
  pi?: PiConductorAuthOptions;
  provider?: string;
  modelId?: string;
  apiKey?: string;
  oauthCallbacks?: OAuthLoginCallbacks;
}

export type ConductorAuthStatus = SdkAuthStatus | PiConductorAuthStatus;
export type ConductorLoginResult = SdkLoginResult | PiConductorLoginResult;
export type ConductorLogoutResult = void | PiConductorLogoutResult;

export interface ConductorAuthRecoveryOptions {
  backend?: ConductorBackend;
  pi?: { agentDir?: string };
  provider?: string;
}

/** Resolve the auth facade's backend using the same rule as conductor startup. */
export function resolveConductorAuthBackend(
  options: Pick<ConductorAuthOptions, 'backend' | 'profile' | 'config'> = {},
): ConductorBackend {
  if (options.backend) return options.backend;
  if (options.profile || options.config) {
    return resolveConductorBackendSetting({
      profile: options.profile,
      config: options.config,
    });
  }
  return 'cursor';
}

/** RunResult.error 等の message が conductor 認証失敗か判定する。 */
export function isConductorAuthError(message: string): boolean {
  return /authentication error|not logged in|invalid api key|no api key(?: for provider)?\s*[: ]|unauthenticated|unauthorized|\b(?:http\s*)?401\b|try logging out/i.test(
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
export function formatConductorAuthRecoveryHint(
  agentId?: string,
  options: ConductorAuthRecoveryOptions = {},
): string {
  const resume = agentId ? `--resume ${agentId}` : '--resume <agentId>';

  if (resolveConductorAuthBackend(options) === 'pi') {
    const provider = options.provider ?? '<provider>';
    const agentDir = options.pi?.agentDir ?? '~/.ensemble/pi';
    return (
      `[auth] Pi 認証エラー（provider=${provider}）。` +
      `ensemble auth login --provider ${provider} を実行するか、${agentDir}/auth.json または ` +
      `環境変数 ${formatPiProviderEnvHint(provider)} を確認してください。` +
      `ensemble issue ... ${resume} で再試行できます。`
    );
  }

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

/** SDK stored login または Pi credential があるか（同期チェック）。 */
export function hasConductorAuth(options: ConductorAuthOptions = {}): boolean {
  if (resolveConductorAuthBackend(options) === 'pi') {
    return hasPiConductorAuth({
      ...(options.pi ?? { cwd: process.cwd() }),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    });
  }
  if (process.env.CURSOR_API_KEY) return true;
  return existsSync(getDefaultSdkAuthPath());
}

export async function getConductorAuthStatus(
  options: ConductorAuthOptions = {},
): Promise<ConductorAuthStatus> {
  if (resolveConductorAuthBackend(options) === 'pi') {
    return getPiConductorAuthStatus({
      ...(options.pi ?? { cwd: process.cwd() }),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    });
  }
  return Cursor.auth.status();
}

export async function loginConductor(
  options: ConductorAuthOptions = {},
): Promise<ConductorLoginResult> {
  if (resolveConductorAuthBackend(options) === 'pi') {
    return loginPiConductor({
      ...(options.pi ?? { cwd: process.cwd() }),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.oauthCallbacks ? { oauthCallbacks: options.oauthCallbacks } : {}),
    });
  }
  return Cursor.auth.login();
}

export async function logoutConductor(
  options: ConductorAuthOptions = {},
): Promise<ConductorLogoutResult> {
  if (resolveConductorAuthBackend(options) === 'pi') {
    return logoutPiConductor({
      ...(options.pi ?? { cwd: process.cwd() }),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    });
  }
  return Cursor.auth.logout();
}
