import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { listModels, upsertModel, deleteModel } from '../lib/api.js';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import type { ModelConfig } from '../lib/types.js';

const PROVIDERS: ModelConfig['provider'][] = ['openai', 'anthropic', 'ollama', 'openai-compatible', 'google'];

export function Models() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['models'], queryFn: listModels });
  const upsert = useMutation({ mutationFn: (m: Partial<ModelConfig> & { name: string }) => upsertModel(m), onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }) });
  const del = useMutation({ mutationFn: (name: string) => deleteModel(name), onSuccess: () => qc.invalidateQueries({ queryKey: ['models'] }) });

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<ModelConfig> & { name: string }>({ name: '', provider: 'openai', model: '', apiKeyEnv: '', maxTurns: 20, temperature: 0.2, maxTokens: 4096 });

  const startAdd = () => { setEditing('new'); setForm({ name: '', provider: 'openai', model: '', apiKeyEnv: '', maxTurns: 20, temperature: 0.2, maxTokens: 4096 }); };
  const startEdit = (m: ModelConfig) => { setEditing(m.name); setForm(m); };
  const set = (k: keyof ModelConfig, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-28 font-600">Models</h1>
        <Button onClick={startAdd}><Plus size={16} /> Add model</Button>
      </div>

      <Modal open={editing === 'new'} onClose={() => setEditing(null)} title="Add Model">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name (unique)">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Provider">
            <select
              value={form.provider}
              onChange={(e) => set('provider', e.target.value as ModelConfig['provider'])}
              className="h-40 w-full rounded-inner border border-border bg-bg-2 px-3 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Model id"><Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o" /></Field>
          <Field label="API key env var"><Input value={form.apiKeyEnv ?? ''} onChange={(e) => set('apiKeyEnv', e.target.value)} placeholder="OPENAI_API_KEY" /></Field>
          <Field label="Base URL (optional)"><Input value={form.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" /></Field>
          <Field label="Temperature"><Input type="number" step="0.1" value={form.temperature} onChange={(e) => set('temperature', Number(e.target.value))} /></Field>
          <Field label="Max turns"><Input type="number" value={form.maxTurns} onChange={(e) => set('maxTurns', Number(e.target.value))} /></Field>
          <Field label="Max tokens"><Input type="number" value={form.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value))} /></Field>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button disabled={upsert.isPending || !form.name || !form.model} onClick={() => upsert.mutate(form, { onSuccess: () => setEditing(null) })}>
            {upsert.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Modal>

      <Modal open={!!editing && editing !== 'new'} onClose={() => setEditing(null)} title={`Edit ${editing}`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Model id"><Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o" /></Field>
          <Field label="Provider">
            <select
              value={form.provider}
              onChange={(e) => set('provider', e.target.value as ModelConfig['provider'])}
              className="h-40 w-full rounded-inner border border-border bg-bg-2 px-3 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="API key env var"><Input value={form.apiKeyEnv ?? ''} onChange={(e) => set('apiKeyEnv', e.target.value)} placeholder="OPENAI_API_KEY" /></Field>
          <Field label="Base URL (optional)"><Input value={form.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" /></Field>
          <Field label="Temperature"><Input type="number" step="0.1" value={form.temperature} onChange={(e) => set('temperature', Number(e.target.value))} /></Field>
          <Field label="Max turns"><Input type="number" value={form.maxTurns} onChange={(e) => set('maxTurns', Number(e.target.value))} /></Field>
          <Field label="Max tokens"><Input type="number" value={form.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value))} /></Field>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button disabled={upsert.isPending || !form.name || !form.model} onClick={() => upsert.mutate(form, { onSuccess: () => setEditing(null) })}>
            {upsert.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Modal>

      <Panel>
        <div className="divide-y divide-border">
          {list.data?.map((m) => (
            <div key={m.name} className="flex items-center justify-between p-3">
              <div>
                <div className="font-mono text-16 text-fg-0">{m.name}</div>
                <div className="font-body text-12 text-fg-1">{m.provider} · {m.model} · maxTurns {m.maxTurns} · temp {m.temperature}</div>
              </div>
              <div className="flex items-center gap-2">
                {m.apiKeyEnv ? <Badge variant="provider" value={m.apiKeyEnv} /> : <Badge variant="status" value="no key" />}
                <Button size="sm" variant="ghost" onClick={() => startEdit(m)}>Edit</Button>
                <Button size="sm" variant="danger" onClick={() => del.mutate(m.name)}><Trash2 size={14} /></Button>
              </div>
            </div>
          ))}
        </div>
        <div className="pt-3 font-body text-12 text-fg-1">
          API keys are referenced by env-var name only and are never stored in or returned through the dashboard.
        </div>
      </Panel>
    </div>
  );
}
