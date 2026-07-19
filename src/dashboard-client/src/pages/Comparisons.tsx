import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listRuns } from '../lib/api.js';
import { Card, Badge, Spinner } from '../components/ui.js';
import type { RunIndexRecord } from '../lib/types.js';

function fmt(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function Comparisons() {
  const q = useQuery({ queryKey: ['runs'], queryFn: listRuns, refetchInterval: 5000 });
  const runs = q.data ?? [];

  // Group by scenario (latest first within each group)
  const byScenario = new Map<string, RunIndexRecord[]>();
  for (const r of runs) {
    const arr = byScenario.get(r.scenario) ?? [];
    arr.push(r);
    byScenario.set(r.scenario, arr);
  }

  return (
    <div className="p-6 space-y-5">
      <h1 className="text-xl font-semibold">Comparisons</h1>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-muted text-sm"><Spinner /> Loading…</div>
      ) : runs.length === 0 ? (
        <Card className="p-6 text-center text-muted text-sm">No runs yet.</Card>
      ) : (
        [...byScenario.entries()].map(([scenario, recs]) => (
          <div key={scenario}>
            <h2 className="text-sm font-medium text-muted mb-2">{scenario}</h2>
            <div className="space-y-3">
              {recs.map((r) => (
                <Card key={r.runId} className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <Link to={`/runs/${r.runId}`} className="text-sm font-medium hover:underline">{r.runId}</Link>
                    <Badge color={r.status === 'completed' ? 'slate' : r.status === 'running' ? 'green' : r.status === 'errored' ? 'red' : 'yellow'}>{r.status}</Badge>
                  </div>
                  <div className="overflow-auto nice-scroll">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted text-left">
                          <th className="py-1 pr-4">Model</th>
                          <th className="py-1 pr-4">Result</th>
                          <th className="py-1 pr-4">Turns</th>
                          <th className="py-1 pr-4">Tools</th>
                          <th className="py-1 pr-4">Duration</th>
                          <th className="py-1 pr-4">Stop</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.perModel.map((m) => (
                          <tr key={m.model} className="border-t border-border">
                            <td className="py-1 pr-4">{m.model}</td>
                            <td className="py-1 pr-4">{m.success === true ? <Badge color="green">PASS</Badge> : m.success === false ? <Badge color="red">FAIL</Badge> : <Badge>—</Badge>}</td>
                            <td className="py-1 pr-4">{m.turnsUsed ?? '—'}</td>
                            <td className="py-1 pr-4">{m.totalToolCalls ?? '—'}</td>
                            <td className="py-1 pr-4">{fmt(m.durationMs)}</td>
                            <td className="py-1 pr-4">{m.stopReason ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
