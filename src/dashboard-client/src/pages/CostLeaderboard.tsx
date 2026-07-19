import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

interface LeaderboardEntry {
  model: string;
  runs: number;
  successes: number;
  successRate: number;
  totalCost: number;
  costPerSuccess: number;
  avgCostPerRun: number;
  totalTokens: number;
}

export function CostLeaderboard() {
  const [data, setData] = useState<{ leaderboard: LeaderboardEntry[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/analytics/cost')
      .then(res => res.json())
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
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-4">Cost Leaderboard</h1>
      
      <p className="text-sm text-muted mb-4">
        Models ranked by cost per successful task. Lower is better.
      </p>

      <div className="bg-card rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/20">
              <th className="text-left py-3 px-4">Rank</th>
              <th className="text-left py-3 px-4">Model</th>
              <th className="text-right py-3 px-4">Runs</th>
              <th className="text-right py-3 px-4">Successes</th>
              <th className="text-right py-3 px-4">Success Rate</th>
              <th className="text-right py-3 px-4">Total Cost</th>
              <th className="text-right py-3 px-4">Cost/Success</th>
              <th className="text-right py-3 px-4">Avg Cost/Run</th>
              <th className="text-right py-3 px-4">Total Tokens</th>
            </tr>
          </thead>
          <tbody>
            {(data?.leaderboard ?? []).map((entry, index) => (
              <tr key={entry.model} className="border-b border-border/50 hover:bg-muted/10">
                <td className="py-3 px-4 font-semibold">#{index + 1}</td>
                <td className="py-3 px-4 font-mono">{entry.model}</td>
                <td className="text-right py-3 px-4">{entry.runs}</td>
                <td className="text-right py-3 px-4">{entry.successes}</td>
                <td className="text-right py-3 px-4">{(entry.successRate * 100).toFixed(1)}%</td>
                <td className="text-right py-3 px-4">${entry.totalCost.toFixed(4)}</td>
                <td className="text-right py-3 px-4 font-semibold">
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
