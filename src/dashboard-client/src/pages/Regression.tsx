import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Spinner } from '../components/ui/Spinner';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { listRegressionSuites, runRegression } from '../lib/api';
import type { RegressionResult } from '../lib/api';

export function Regression() {
  const [selectedSuite, setSelectedSuite] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [updateBaseline, setUpdateBaseline] = useState(false);
  const [result, setResult] = useState<RegressionResult | null>(null);

  const suites = useQuery({
    queryKey: ['regression', 'suites'],
    queryFn: listRegressionSuites,
  });

  const runMut = useMutation({
    mutationFn: () => runRegression({ suite: selectedSuite, model: filterModel || undefined, updateBaseline }),
    onSuccess: (data) => setResult(data),
  });

  if (suites.isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-44 font-700">Regression</h1>

      <Panel>
        <PanelHeader title="Run Regression Suite" />
        <PanelBody>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-12 text-fg-1">Suite</span>
              <select value={selectedSuite} onChange={e => setSelectedSuite(e.target.value)} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0">
                <option value="">Select suite...</option>
                {(suites.data ?? []).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-12 text-fg-1">Model (optional filter)</span>
              <input type="text" value={filterModel} onChange={e => setFilterModel(e.target.value)} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0 w-32" />
            </label>
            <label className="flex items-center gap-2 pb-1">
              <input type="checkbox" checked={updateBaseline} onChange={e => setUpdateBaseline(e.target.checked)} />
              <span className="text-14">Update baselines</span>
            </label>
            <Button variant="primary" size="sm" onClick={() => runMut.mutate()} disabled={!selectedSuite || runMut.isPending}>
              {runMut.isPending ? 'Running...' : 'Run'}
            </Button>
          </div>
          {runMut.error && <p className="text-red-500 text-sm mt-3">{(runMut.error as Error).message}</p>}
        </PanelBody>
      </Panel>

      {result && (
        <Panel>
          <PanelHeader title={`Suite: ${result.suite}`} actions={<Badge variant="status" value={result.passed ? 'PASSED' : 'FAILED'} className={result.passed ? 'text-green-500' : 'text-red-500'} />} />
          <PanelBody>
            <div className="text-12 text-fg-1 mb-3">
              Run: <code>{result.runId}</code> · Models: {result.model} · {new Date(result.timestamp).toLocaleString()}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-display">Scenario</th>
                  <th className="text-left py-2 px-2 font-display">Status</th>
                  <th className="text-right py-2 px-2 font-display">Duration</th>
                  <th className="text-right py-2 px-2 font-display">Turns</th>
                  <th className="text-left py-2 px-2 font-display">Regressions</th>
                </tr>
              </thead>
              <tbody>
                {result.scenarioResults.map((sr, i) => (
                  <tr key={`${sr.scenario}-${i}`} className="border-b border-border/50">
                    <td className="py-2 px-2 font-mono text-12">{sr.scenario}</td>
                    <td className="py-2 px-2">
                      <Badge variant="status" value={sr.success ? 'PASS' : 'FAIL'} className={sr.success ? 'text-green-500' : 'text-red-500'} />
                    </td>
                    <td className="text-right py-2 px-2">{(sr.current.durationMs / 1000).toFixed(1)}s</td>
                    <td className="text-right py-2 px-2">{sr.current.turnsUsed}</td>
                    <td className="py-2 px-2">
                      {!sr.regression ? <span className="text-12 text-fg-1">no baseline</span> : !sr.regression.passed ? (
                        <div className="flex flex-col gap-1">
                          {sr.regression.regressions.map((r, j) => (
                            <span key={j} className="text-11 text-red-500">
                              {r.metric}: {r.baseline.toFixed(2)} → {r.current.toFixed(2)} (Δ{r.change.toFixed(2)})
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-12 text-green-500">no regressions</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}
