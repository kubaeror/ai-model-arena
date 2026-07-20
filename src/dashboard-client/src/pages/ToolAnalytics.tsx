import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../lib/api.js';

interface ToolStat {
  name: string;
  totalCalls: number;
  failedCalls: number;
  successCalls: number;
  avgPerRun: number;
  avgPerSuccessfulTask: number;
}

interface AnalyticsResponse {
  model: string | null;
  totalRuns: number;
  successfulRuns: number;
  totalToolCalls: number;
  toolStats: ToolStat[];
  failedRate: number;
  avgCallsPerSuccess: number;
  loopIncidents: Array<{
    runId: string;
    model: string;
    turn: number;
    tools: string[];
  }>;
}

export function ToolAnalytics() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (modelFilter) params.set('model', modelFilter);
    
    api.get(`/analytics/tools?${params}`)
      .then(res => res.json())
      .then(d => {
        setData(d);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, [modelFilter]);

  if (loading) return <div className="p-6">Loading...</div>;
  if (error) return <div className="p-6 text-red-500">Error: {error}</div>;

  const chartData = (data?.toolStats ?? []).slice(0, 10).map(s => ({
    name: s.name,
    calls: s.totalCalls,
    failed: s.failedCalls,
  }));

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-4">Tool Analytics</h1>
      
      <div className="flex gap-4 mb-6">
        <div className="bg-card p-4 rounded-lg border border-border">
          <div className="text-sm text-muted">Total Runs</div>
          <div className="text-2xl font-semibold">{data?.totalRuns ?? 0}</div>
        </div>
        <div className="bg-card p-4 rounded-lg border border-border">
          <div className="text-sm text-muted">Success Rate</div>
          <div className="text-2xl font-semibold">
            {data?.totalRuns ? ((data.successfulRuns / data.totalRuns) * 100).toFixed(1) : 0}%
          </div>
        </div>
        <div className="bg-card p-4 rounded-lg border border-border">
          <div className="text-sm text-muted">Total Tool Calls</div>
          <div className="text-2xl font-semibold">{data?.totalToolCalls ?? 0}</div>
        </div>
        <div className="bg-card p-4 rounded-lg border border-border">
          <div className="text-sm text-muted">Loop Incidents</div>
          <div className="text-2xl font-semibold text-amber-500">{data?.loopIncidents.length ?? 0}</div>
        </div>
      </div>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Filter by model..."
          value={modelFilter}
          onChange={e => setModelFilter(e.target.value)}
          className="border border-border bg-background px-3 py-1.5 rounded text-sm"
        />
      </div>

      <div className="bg-card p-4 rounded-lg border border-border mb-6">
        <h2 className="text-sm font-semibold mb-3">Tool Call Distribution</h2>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <XAxis dataKey="name" fontSize={10} />
            <YAxis fontSize={10} />
            <Tooltip />
            <Bar dataKey="calls" fill="#3b82f6" name="Total" />
            <Bar dataKey="failed" fill="#ef4444" name="Failed" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-card p-4 rounded-lg border border-border">
        <h2 className="text-sm font-semibold mb-3">Tool Statistics</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2">Tool</th>
              <th className="text-right py-2">Total</th>
              <th className="text-right py-2">Failed</th>
              <th className="text-right py-2">Avg/Run</th>
            </tr>
          </thead>
          <tbody>
            {(data?.toolStats ?? []).map(s => (
              <tr key={s.name} className="border-b border-border/50">
                <td className="py-2 font-mono text-xs">{s.name}</td>
                <td className="text-right">{s.totalCalls}</td>
                <td className="text-right">{s.failedCalls}</td>
                <td className="text-right">{s.avgPerRun.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
