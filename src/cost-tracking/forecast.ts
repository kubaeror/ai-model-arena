/**
 * Simple exponential smoothing forecast for daily and monthly cost.
 * Uses alpha = 0.3 (30% weight on most recent observation).
 * Returns projected cost for the current day/month based on recent trends.
 */
export function forecastCost(
  historicalDaily: number[],
  historicalMonthly: number[],
  daysInMonth: number,
  todayDay: number,
): {
  projectedDaily: number;
  projectedMonthly: number;
  trend: 'stable' | 'increasing' | 'decreasing';
} {
  const alpha = 0.3;
  let projectedDaily = 0;
  let projectedMonthly = 0;
  let trend: 'stable' | 'increasing' | 'decreasing' = 'stable';

  if (historicalDaily.length >= 2) {
    // Exponential smoothing
    let smoothed = historicalDaily[0]!;
    for (let i = 1; i < historicalDaily.length; i++) {
      smoothed = alpha * historicalDaily[i]! + (1 - alpha) * smoothed;
    }
    projectedDaily = smoothed;

    // Trend detection
    const recent = historicalDaily.slice(-3);
    if (recent.length >= 2 && recent[recent.length - 1]! > recent[0]! * 1.2) {
      trend = 'increasing';
    } else if (recent.length >= 2 && recent[recent.length - 1]! < recent[0]! * 0.8) {
      trend = 'decreasing';
    }
  } else if (historicalDaily.length === 1) {
    projectedDaily = historicalDaily[0]!;
  }

  if (historicalMonthly.length > 0 && daysInMonth > 0) {
    const avgDaily = projectedDaily > 0 ? projectedDaily :
      (historicalMonthly.reduce((a, b) => a + b, 0) / historicalMonthly.length / 30);
    projectedMonthly = avgDaily * daysInMonth;

    // Adjust for partial month
    const progress = Math.min(todayDay / daysInMonth, 1);
    if (progress > 0 && historicalMonthly[0] !== undefined) {
      const currentMonthSpend = historicalMonthly[0]!;
      // If current month spend is already close to projection, adjust upward
      if (currentMonthSpend > projectedMonthly * progress * 0.8) {
        projectedMonthly = Math.max(projectedMonthly, currentMonthSpend / progress * 1.1);
      }
    }
  }

  return { projectedDaily, projectedMonthly, trend };
}

interface CostRecord {
  day: string;
  costUsd: number;
  model: string;
}

export function extractDailyCosts(records: CostRecord[], model: string, days = 30): number[] {
  const daily = new Map<string, number>();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  for (const r of records) {
    if (r.model !== model) continue;
    const d = r.day;
    const parsed = new Date(d);
    if (parsed >= cutoff) {
      daily.set(d, (daily.get(d) ?? 0) + r.costUsd);
    }
  }

  return [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}
