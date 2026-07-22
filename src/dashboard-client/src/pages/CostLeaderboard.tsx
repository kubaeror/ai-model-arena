import { useEffect, useState } from 'react';
import { getCostLeaderboard } from '../lib/api.js';
import type { CostLeaderboardEntry } from '../lib/api.js';

export function CostLeaderboard() {
  const [data, setData] = useState<CostLeaderboardEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCostLeaderboard()
      .then(d => {
        setData(d);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="p-6">Loading...</div>;
  if (error) return <div className="p-6 text-red-500">Error: {error}</div>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Cost Leaderboard</h1>
      
      <p className="text-sm text-fg-1">
        Models ranked by cost per successful task. Lower is better.
      </p>

      <div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-3 px-4 font-display">Rank</th>
              <th className="text-left py-3 px-4 font-display">Model</th>
              <th className="text-right py-3 px-4 font-display">Runs</th>
              <th className="text-right py-3 px-4 font-display">Successes</th>
              <th className="text-right py-3 px-4 font-display">Success Rate</th>
              <th className="text-right py-3 px-4 font-display">Total Cost</th>
              <th className="text-right py-3 px-4 font-display">Cost/Success</th>
              <th className="text-right py-3 px-4 font-display">Avg Cost/Run</th>
              <th className="text-right py-3 px-4 font-display">Total Tokens</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((entry, index) => (
              <tr key={entry.model} className="border-b border-border/50 hover:bg-bg-1">
                <td className="py-3 px-4 font-600">#{index + 1}</td>
                <td className="py-3 px-4 font-mono">{entry.model}</td>
                <td className="text-right py-3 px-4">{entry.runs}</td>
                <td className="text-right py-3 px-4">{entry.successes}</td>
                <td className="text-right py-3 px-4">{(entry.successRate * 100).toFixed(1)}%</td>
                <td className="text-right py-3 px-4">${entry.totalCost.toFixed(4)}</td>
                <td className="text-right py-3 px-4 font-600">
                  {entry.successes > 0 ? `$${entry.costPerSuccess.toFixed(4)}` : '-'}
                </td>
                <td className="text-right py-3 px-4">${entry.avgCostPerRun.toFixed(4)}</td>
                <td className="text-right py-3 px-4">{entry.totalTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
