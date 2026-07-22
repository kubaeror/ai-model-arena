import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { DataTable } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { listSchedules, createSchedule, deleteSchedule, listScenarios, listModels } from '../lib/api';
import type { Column } from '../components/ui/DataTable';
import type { Schedule } from '../lib/api';

export function Schedules() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ id: '', scenario: '', models: '', cron: '', enabled: true });
  const [formError, setFormError] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['schedules'],
    queryFn: listSchedules,
    refetchInterval: 30_000,
  });

  const scenarios = useQuery({
    queryKey: ['scenarios'],
    queryFn: listScenarios,
  });

  const models = useQuery({
    queryKey: ['models'],
    queryFn: listModels,
  });

  const createMut = useMutation({
    mutationFn: () => createSchedule({
      id: form.id || undefined,
      scenario: form.scenario,
      models: form.models.split(',').map(m => m.trim()).filter(Boolean),
      cron: form.cron,
      enabled: form.enabled,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      setShowCreate(false);
      setForm({ id: '', scenario: '', models: '', cron: '', enabled: true });
      setFormError('');
    },
    onError: (e) => setFormError((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });

  const columns: Column<Schedule>[] = [
    { key: 'id', header: 'ID', sortable: true },
    { key: 'scenario', header: 'Scenario', sortable: true },
    { key: 'models', header: 'Models', render: r => <span className="font-mono text-12">{r.models.join(', ')}</span> },
    { key: 'cron', header: 'Cron', render: r => <code className="text-12">{r.cron}</code>, sortable: true },
    { key: 'enabled', header: 'Status', render: r => r.enabled ? <Badge variant="status" value="enabled" className="text-green-500" /> : <Badge variant="status" value="disabled" className="text-fg-1" /> },
    { key: 'state', header: 'State', render: r => r.state ? <span className="text-12">{r.state.status}{r.state.totalRuns > 0 ? ` (${r.state.totalRuns} runs)` : ''}</span> : '—' },
    {
      key: 'actions', header: 'Actions', render: r => (
        <Button variant="danger" size="sm" onClick={() => { if (window.confirm('Delete schedule?')) deleteMut.mutate(r.id); }}>Delete</Button>
      ),
    },
  ];

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (error) return <div className="text-red-500 py-4">Error: {(error as Error).message}</div>;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-44 font-700">Schedules</h1>

      <Panel>
        <PanelHeader title="Scheduled Jobs" actions={<Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>New Schedule</Button>} />
        <PanelBody>
          {(!data || data.length === 0) ? <EmptyState title="No schedules configured" /> : (
            <DataTable columns={columns} data={data} />
          )}
        </PanelBody>
      </Panel>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Schedule">
        <div className="flex flex-col gap-4">
          {formError && <p className="text-red-500 text-sm">{formError}</p>}

          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Scenario</span>
            <select value={form.scenario} onChange={e => setForm(f => ({ ...f, scenario: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0">
              <option value="">Select...</option>
              {(scenarios.data ?? []).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Models (comma-separated)</span>
            <input type="text" value={form.models} onChange={e => setForm(f => ({ ...f, models: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" placeholder="gpt-4o, claude-3.7" />
            {models.data && models.data.length > 0 && (
              <span className="text-11 text-fg-1">Available: {models.data.map(m => m.name).join(', ')}</span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Cron expression</span>
            <input type="text" value={form.cron} onChange={e => setForm(f => ({ ...f, cron: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" placeholder="0 */6 * * *" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Schedule ID (optional)</span>
            <input type="text" value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" placeholder="auto-generated" />
          </label>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
            <span className="text-14">Enabled</span>
          </label>

          <div className="flex gap-2 mt-2">
            <Button variant="primary" size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
              {createMut.isPending ? 'Creating...' : 'Create'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
