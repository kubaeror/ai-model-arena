import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listRuns } from '../lib/api.js';
import { PageShell } from '../components/ui/PageShell';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import type { RunIndexRecord } from '../lib/types.js';

function fmt(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function Comparisons() {
  const q = useQuery({ queryKey: ['runs'], queryFn: listRuns, refetchInterval: 5000 });
  const runs = q.data ?? [];

  const byScenario = new Map<string, RunIndexRecord[]>();
  for (const r of runs) {
    const arr = byScenario.get(r.scenario) ?? [];
    arr.push(r);
    byScenario.set(r.scenario, arr);
  }

  return (
    <PageShell
      title="Comparisons"
      description="Side-by-side model results grouped by scenario"
      loading={q.isLoading}
    >
      {runs.length === 0 ? (
        <Panel className="p-6 text-center"><EmptyState title="No runs yet" description="Launch a run from the Home page to see comparisons." /></Panel>
      ) : (
        <div className="flex flex-col gap-6">
          {[...byScenario.entries()].map(([scenario, recs]) => (
            <div key={scenario}>
              <h2 className="font-display text-14 font-500 text-fg-1 mb-2">{scenario}</h2>
              <div className="flex flex-col gap-3">
                {recs.map((r) => (
                  <Panel key={r.runId} className="p-3">
                    <div className="flex items-center justify-between mb-2">
                      <Link to={`/runs/${r.runId}`} className="font-mono text-14 text-accent hover:underline">{r.runId}</Link>
                      <Badge variant="status" value={r.status} />
                    </div>
                    <div className="overflow-auto nice-scroll">
                      <table className="w-full text-12">
                        <thead>
                          <tr className="text-fg-1 text-left border-b border-border">
                            <th className="py-1 pr-1 font-display font-500">Model</th>
                            <th className="py-1 pr-1 font-display font-500">Result</th>
                            <th className="py-1 pr-1 font-display font-500">Turns</th>
                            <th className="py-1 pr-1 font-display font-500">Tools</th>
                            <th className="py-1 pr-1 font-display font-500">Duration</th>
                            <th className="py-1 pr-1 font-display font-500">Stop</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.perModel.map((m) => (
                            <tr key={m.model} className="border-t border-border/50">
                              <td className="py-1 pr-1 font-mono text-12">{m.model}</td>
                              <td className="py-1 pr-1">
                                {m.success === true ? <Badge variant="success" value="PASS" /> :
                                 m.success === false ? <Badge variant="failure" value="FAIL" /> :
                                 <span className="text-fg-1">—</span>}
                              </td>
                              <td className="py-1 pr-1 font-mono text-12">{m.turnsUsed ?? '—'}</td>
                              <td className="py-1 pr-1 font-mono text-12">{m.totalToolCalls ?? '—'}</td>
                              <td className="py-1 pr-1 font-mono text-12">{fmt(m.durationMs)}</td>
                              <td className="py-1 pr-1 font-mono text-12">{m.stopReason ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
