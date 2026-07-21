import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { listModels, listScenarios, triggerRun } from '../lib/api.js';
import { Button, Card, Select } from '../components/ui.js';
import type { ModelConfig, ScenarioConfig } from '../lib/types.js';

export function Launcher() {
  const navigate = useNavigate();
  const models = useQuery({ queryKey: ['models'], queryFn: listModels });
  const scenarios = useQuery({ queryKey: ['scenarios'], queryFn: listScenarios });
  const [scenario, setScenario] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const run = useMutation({
    mutationFn: () => triggerRun(scenario, [...selected]),
    onSuccess: (r) => navigate(`/runs/${r.runId}`),
  });

  const toggle = (name: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const scenarioName = scenario || scenarios.data?.[0]?.name || '';

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <h1 className="text-xl font-semibold">Launch a run</h1>

      <Card className="p-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-muted mb-1">Scenario</label>
          <Select value={scenarioName} onChange={(e) => setScenario(e.target.value)}>
            {scenarios.isLoading ? <option>Loading…</option> : scenarios.data?.map((s: ScenarioConfig) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1">Models ({selected.size} selected)</label>
          <div className="space-y-1">
            {models.data?.map((m: ModelConfig) => (
              <label key={m.name} className="flex items-center gap-2 p-2 rounded hover:bg-muted/10 cursor-pointer">
                <input type="checkbox" checked={selected.has(m.name)} onChange={() => toggle(m.name)} />
                <span className="text-sm">{m.name}</span>
                <span className="text-xs text-muted">{m.provider} · {m.model}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={run.isPending || !scenarioName || selected.size === 0} onClick={() => run.mutate()}>
            <Play size={16} /> {run.isPending ? 'Starting…' : 'Run'}
          </Button>
          {run.isError && <span className="text-red-400 text-sm">{(run.error as Error)?.message}</span>}
        </div>
      </Card>
    </div>
  );
}
