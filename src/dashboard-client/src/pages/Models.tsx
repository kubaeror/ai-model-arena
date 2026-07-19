import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { listModels, upsertModel, deleteModel } from '../lib/api.js';
import { Button, Card, Field, Input, Select, Label, Badge } from '../components/ui.js';
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
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Models</h1>
        <Button onClick={startAdd}><Plus size={16} /> Add model</Button>
      </div>

      {editing && (
        <Card className="p-5 grid grid-cols-2 gap-4 max-w-3xl">
          <Field label="Name (unique)"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Provider">
            <Select value={form.provider} onChange={(e) => set('provider', e.target.value as ModelConfig['provider'])}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="Model id"><Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o" /></Field>
          <Field label="API key env var name (never the key itself)"><Input value={form.apiKeyEnv ?? ''} onChange={(e) => set('apiKeyEnv', e.target.value)} placeholder="OPENAI_API_KEY" /></Field>
          <Field label="Base URL (optional)"><Input value={form.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Temperature"><Input type="number" step="0.1" value={form.temperature} onChange={(e) => set('temperature', Number(e.target.value))} /></Field>
            <Field label="Max turns"><Input type="number" value={form.maxTurns} onChange={(e) => set('maxTurns', Number(e.target.value))} /></Field>
            <Field label="Max tokens"><Input type="number" value={form.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value))} /></Field>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={upsert.isPending || !form.name || !form.model} onClick={() => upsert.mutate(form, { onSuccess: () => setEditing(null) })}>{upsert.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </Card>
      )}

      <Card className="divide-y divide-border">
        {list.data?.map((m) => (
          <div key={m.name} className="flex items-center justify-between p-3">
            <div>
              <div className="font-medium text-sm">{m.name}</div>
              <div className="text-xs text-muted">{m.provider} · {m.model} · maxTurns {m.maxTurns} · temp {m.temperature}</div>
            </div>
            <div className="flex items-center gap-2">
              {m.apiKeyEnv ? <Badge color="blue">{m.apiKeyEnv}</Badge> : <Badge>no key</Badge>}
              <Button size="sm" variant="ghost" onClick={() => startEdit(m)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => del.mutate(m.name)}><Trash2 size={14} /></Button>
            </div>
          </div>
        ))}
      </Card>
      <p className="text-muted text-xs">API keys are referenced by env-var name only and are never stored in or returned through the dashboard.</p>
    </div>
  );
}
