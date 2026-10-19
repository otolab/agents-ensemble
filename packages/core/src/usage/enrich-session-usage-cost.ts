import type { ConductorUsageCost } from '../conductor/conductor-agent.js';
import type { SessionUsageSummary } from './types.js';

export type GetConductorUsageCost = () => Promise<ConductorUsageCost | undefined>;

/**
 * Conductor が報告した請求記録を session usage にマージする。
 * 推定値は渡さず、未取得・失敗時は元の summary を返す。
 */
export async function enrichSessionUsageWithCost(
  summary: SessionUsageSummary,
  getCost?: GetConductorUsageCost,
): Promise<SessionUsageSummary> {
  if (!getCost) {
    return summary;
  }

  try {
    const cost = await getCost();
    if (cost == null) {
      return summary;
    }
    return { ...summary, cost };
  } catch {
    return summary;
  }
}
