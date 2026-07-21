import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { listScenarios, getScenario, deleteScenario } from '../lib/api.js';
import { Button, Card, Badge, Spinner } from '../components/ui.js';
import { ScenarioForm } from '../components/ScenarioForm.js';
import type { ScenarioConfig } from '../lib/types.js';

export function Scenarios() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'create' } | { kind: 'edit'; name: string }>({ kind: 'list' });
  const list = useQuery({ queryKey: ['scenarios'], queryFn: listScenarios });

  const editQuery = useQuery({
    queryKey: ['scenario', mode.kind === 'edit' ? mode.name : ''],
    queryFn: () => getScenario((mode as { kind: 'edit'; name: string }).name),
    enabled: mode.kind === 'edit',
  });

  const del = useMutation({
    mutationFn: (name: string) => deleteScenario(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scenarios'] }),
  });

  if (mode.kind === 'create') {
    return (
      <div className="p-6">
        <ScenarioForm onSaved={() => setMode({ kind: 'list' })} onCancel={() => setMode({ kind: 'list' })} />
      </div>
    );
  }
  if (mode.kind === 'edit') {
    return (
      <div className="p-6">
        {editQuery.isLoading ? (
          <div className="flex items-center gap-2 text-muted text-sm"><Spinner /> Loading…</div>
        ) : editQuery.data ? (
          <ScenarioForm
            initial={{ scenario: editQuery.data.scenario, starterFiles: editQuery.data.starterFiles }}
            onSaved={() => setMode({ kind: 'list' })}
            onCancel={() => setMode({ kind: 'list' })}
          />
        ) : (
          <div className="text-muted text-sm">Scenario not found.</div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Scenarios</h1>
        <Button onClick={() => setMode({ kind: 'create' })}><Plus size={16} /> New scenario</Button>
      </div>
      <Card className="divide-y divide-border">
        {list.isLoading ? (
          <div className="p-4 flex items-center gap-2 text-muted text-sm"><Spinner /> Loading…</div>
        ) : list.data && list.data.length ? (
          list.data.map((s: ScenarioConfig) => (
            <div key={s.name} className="flex items-center justify-between p-3">
              <div>
                <div className="font-medium text-sm">{s.name}</div>
                <div className="text-xs text-muted">{s.description ?? s.task.slice(0, 80)}</div>
                <div className="text-xs text-muted mt-0.5">
                  {s.starterFiles && <Badge>seeded</Badge>} {s.successCriteria?.command && <span>· criteria: {s.successCriteria.command}</span>}
                  {s.maxTurns && <span> · max turns {s.maxTurns}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setMode({ kind: 'edit', name: s.name })}><Pencil size={14} /></Button>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(s.name)}><Trash2 size={14} /></Button>
              </div>
            </div>
          ))
        ) : (
          <div className="p-6 text-muted text-sm text-center">No scenarios yet. Click “New scenario” to create one.</div>
        )}
      </Card>
    </div>
  );
}
