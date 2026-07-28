import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { listModels, listScenarios, triggerRun } from '../lib/api.js';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Select } from '../components/ui/Select';

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

  const scenarioOptions = scenarios.isLoading
    ? [{ value: '', label: 'Loading…' }]
    : (scenarios.data ?? []).map(s => ({ value: s.name, label: s.name }));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Launch a run</h1>

      <Panel className="p-4 flex flex-col gap-4 max-w-3xl">
        <Select
          label="Scenario"
          value={scenarioName}
          onChange={setScenario}
          options={scenarioOptions}
        />
        <div>
          <span className="font-body text-12 text-fg-1 uppercase mb-2 block">Models ({selected.size} selected)</span>
          <div className="max-h-300 overflow-y-auto rounded-inner border border-border p-2">
            {(models.data ?? []).map(m => (
              <label key={m.name} className="flex items-center gap-2 py-1 px-2 rounded-inner hover:bg-bg-2 cursor-pointer">
                <input type="checkbox" checked={selected.has(m.name)} onChange={() => toggle(m.name)} className="accent-accent" />
                <span className="font-mono text-14">{m.name}</span>
                <span className="font-body text-12 text-fg-1">— {m.provider} · {m.model}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={run.isPending || !scenarioName || selected.size === 0} onClick={() => run.mutate()}>
            <Play size={16} /> {run.isPending ? 'Starting…' : 'Run'}
          </Button>
          {run.isError && <span className="font-mono text-12 text-danger">{(run.error as Error)?.message}</span>}
        </div>
      </Panel>
    </div>
  );
}
