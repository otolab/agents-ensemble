import type { ConductorUsageCost } from '../conductor/conductor-agent.js';
import type { SessionUsageSummary } from './types.js';

export type GetConductorUsageCost = () => Promise<ConductorUsageCost | undefined>;

/** SDK `getUsage().cost` を session usage にマージする。未取得・失敗時は元の summary を返す。 */
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
