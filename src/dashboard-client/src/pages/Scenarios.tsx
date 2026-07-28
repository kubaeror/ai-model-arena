import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { listScenarios, getScenario, deleteScenario } from '../lib/api.js';
import { PageShell } from '../components/ui/PageShell';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
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
      <PageShell title="New Scenario">
        <ScenarioForm onSaved={() => setMode({ kind: 'list' })} onCancel={() => setMode({ kind: 'list' })} />
      </PageShell>
    );
  }
  if (mode.kind === 'edit') {
    return (
      <PageShell title="Edit Scenario">
        {editQuery.isLoading ? (
          <div className="flex items-center gap-2 text-fg-1 text-14"><Spinner /> Loading…</div>
        ) : editQuery.data ? (
          <ScenarioForm
            initial={{ scenario: editQuery.data.scenario, starterFiles: editQuery.data.starterFiles }}
            onSaved={() => setMode({ kind: 'list' })}
            onCancel={() => setMode({ kind: 'list' })}
          />
        ) : (
          <div className="text-fg-1 text-14">Scenario not found.</div>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Scenarios"
      description="Define system prompt, task, and success criteria for agent runs"
      actions={
        <Button onClick={() => setMode({ kind: 'create' })}>
          <Plus size={16} /> New scenario
        </Button>
      }
      loading={list.isLoading}
    >
      <Panel className="divide-y divide-border">
        {list.data && list.data.length ? (
          list.data.map((s: ScenarioConfig) => (
            <div key={s.name} className="flex items-center justify-between p-3">
              <div>
                <div className="font-display text-14 font-500 text-fg-0">{s.name}</div>
                <div className="font-body text-12 text-fg-1">{s.description ?? s.task.slice(0, 80)}</div>
                <div className="font-mono text-12 text-fg-1 mt-1">
                  {s.starterFiles && <Badge variant="neutral" value="seeded" />} {s.successCriteria?.command && <span>criteria: {s.successCriteria.command}</span>}
                  {s.maxTurns && <span> max turns {s.maxTurns}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setMode({ kind: 'edit', name: s.name })}><Pencil size={14} /></Button>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(s.name)}><Trash2 size={14} /></Button>
              </div>
            </div>
          ))
        ) : (
          <div className="p-6 text-center">
            <EmptyState title="No scenarios yet" description="Create one to define how agents should solve tasks." />
          </div>
        )}
      </Panel>
    </PageShell>
  );
}
