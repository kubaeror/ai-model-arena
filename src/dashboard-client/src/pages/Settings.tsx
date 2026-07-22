import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Tabs } from '../components/ui/Tabs';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { useSettings } from '../providers/SettingsProvider';
import { apiFetch, listWebhooks, registerWebhook, deleteWebhook } from '../lib/api';
import type { WebhookRecord } from '../lib/types';

interface ProviderRecord {
  id?: string;
  name?: string;
  provider_id: string;
  api_base?: string;
  apiBase?: string;
  auth_scheme?: string;
  adapter?: string;
  is_builtin?: boolean;
  health?: { reachable: boolean; error?: string };
}

function ProvidersPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['providers'],
    queryFn: async () => {
      const r = await apiFetch<{ builtin: ProviderRecord[]; custom: ProviderRecord[] }>('/api/providers');
      return r;
    },
  });
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ id: '', name: '', apiBase: '', authScheme: 'bearer' as string, envVar: '', adapter: 'openai-compat' as string });
  const [formError, setFormError] = useState('');

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('ai-arena-token')}` },
        body: JSON.stringify({
          id: form.id,
          name: form.name || form.id,
          apiBase: form.apiBase || undefined,
          authScheme: form.authScheme,
          envVar: form.envVar || undefined,
          adapter: form.adapter,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      setShowCreate(false);
      setForm({ id: '', name: '', apiBase: '', authScheme: 'bearer', envVar: '', adapter: 'openai-compat' });
    },
    onError: (e) => setFormError((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });

  if (isLoading) return <Spinner />;
  if (error) return <div className="text-red-500">{(error as Error).message}</div>;

  const builtin = data?.builtin ?? [];
  const custom = data?.custom ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Built-in Providers" />
        <PanelBody>
          {builtin.length === 0 ? <EmptyState title="No built-in providers" /> : (
            <table className="w-full font-mono text-12">
              <thead><tr className="text-fg-1 uppercase border-b border-border">
                <th className="px-2 py-2 text-left">ID</th>
                <th className="px-2 py-2 text-left">Adapter</th>
                <th className="px-2 py-2 text-left">Base URL</th>
              </tr></thead>
              <tbody>
                {builtin.map(b => (
                  <tr key={b.id ?? b.provider_id} className="border-b border-border/50">
                    <td className="px-2 py-2">{b.id ?? b.provider_id}</td>
                    <td className="px-2 py-2"><Badge variant="provider" value={b.adapter ?? '-'} /></td>
                    <td className="px-2 py-2 text-fg-1">{b.api_base ?? b.apiBase ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Custom Providers" actions={<Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>New Provider</Button>} />
        <PanelBody>
          {custom.length === 0 ? <EmptyState title="No custom providers" /> : (
            <table className="w-full font-mono text-12">
              <thead><tr className="text-fg-1 uppercase border-b border-border">
                <th className="px-2 py-2 text-left">ID</th>
                <th className="px-2 py-2 text-left">Name</th>
                <th className="px-2 py-2 text-left">Adapter</th>
                <th className="px-2 py-2 text-left">Base URL</th>
                <th className="px-2 py-2 text-left">Auth</th>
                <th className="px-2 py-2 text-left">Health</th>
                <th className="px-2 py-2 text-left">Actions</th>
              </tr></thead>
              <tbody>
                {custom.map(c => (
                  <tr key={c.id ?? c.provider_id} className="border-b border-border/50">
                    <td className="px-2 py-2">{c.id ?? c.provider_id}</td>
                    <td className="px-2 py-2">{c.name ?? c.id ?? '-'}</td>
                    <td className="px-2 py-2"><Badge variant="provider" value={c.adapter ?? '-'} /></td>
                    <td className="px-2 py-2 text-fg-1">{c.api_base ?? c.apiBase ?? '-'}</td>
                    <td className="px-2 py-2">{c.auth_scheme ?? '-'}</td>
                    <td className="px-2 py-2">
                      {c.health?.reachable === true ? <Badge variant="status" value="reachable" className="text-green-500" /> :
                       c.health?.reachable === false ? <Badge variant="status" value="unreachable" className="text-red-500" /> :
                       <span className="text-fg-1">—</span>}
                    </td>
                    <td className="px-2 py-2">
                      <Button variant="danger" size="sm" onClick={() => { if (window.confirm('Delete provider?')) deleteMut.mutate(c.id ?? c.provider_id); }}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Provider">
        <div className="flex flex-col gap-4">
          {formError && <p className="text-red-500 text-sm">{formError}</p>}
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">ID (lowercase kebab-case)</span>
            <input type="text" value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Display Name</span>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">API Base URL</span>
            <input type="text" value={form.apiBase} onChange={e => setForm(f => ({ ...f, apiBase: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" placeholder="https://api.example.com/v1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Auth Scheme</span>
            <select value={form.authScheme} onChange={e => setForm(f => ({ ...f, authScheme: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0">
              <option value="bearer">Bearer</option>
              <option value="x-api-key">X-API-Key</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Env Variable (for API key)</span>
            <input type="text" value={form.envVar} onChange={e => setForm(f => ({ ...f, envVar: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Adapter</span>
            <select value={form.adapter} onChange={e => setForm(f => ({ ...f, adapter: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0">
              <option value="openai-compat">OpenAI Compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="bedrock">Bedrock</option>
            </select>
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

function WebhooksPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: listWebhooks,
    refetchInterval: 30_000,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ url: '', events: '', secret: '' });
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: async () => {
      await registerWebhook(form.url, form.events.split(',').map(e => e.trim()).filter(Boolean), form.secret || undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setShowCreate(false);
      setForm({ url: '', events: '', secret: '' });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => { await deleteWebhook(id); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Webhooks" actions={<Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>New Webhook</Button>} />
        <PanelBody>
          {isLoading ? <Spinner /> : !data || data.length === 0 ? <EmptyState title="No webhooks" /> : (
            <table className="w-full font-mono text-12">
              <thead><tr className="text-fg-1 uppercase border-b border-border">
                <th className="px-2 py-2 text-left">ID</th>
                <th className="px-2 py-2 text-left">URL</th>
                <th className="px-2 py-2 text-left">Events</th>
                <th className="px-2 py-2 text-left">Actions</th>
              </tr></thead>
              <tbody>
                {(data as WebhookRecord[]).map((w: WebhookRecord) => (
                  <tr key={w.id} className="border-b border-border/50">
                    <td className="px-2 py-2">{w.id}</td>
                    <td className="px-2 py-2 text-fg-1 truncate max-w-[300px]">{w.url}</td>
                    <td className="px-2 py-2">{w.events}</td>
                    <td className="px-2 py-2">
                      <Button variant="danger" size="sm" onClick={() => { if (window.confirm('Delete webhook?')) deleteMut.mutate(w.id); }}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Webhook">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">URL</span>
            <input type="text" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" placeholder="https://example.com/webhook" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Events (comma-separated)</span>
            <input type="text" value={form.events} onChange={e => setForm(f => ({ ...f, events: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" placeholder="run.started, run.completed" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Secret (optional)</span>
            <input type="text" value={form.secret} onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0" />
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

function ProvidersMain() {
  return <ProvidersPanel />;
}

export function Settings() {
  const [tab, setTab] = useState('general');
  const { theme, setTheme } = useSettings();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Settings</h1>
      <Tabs
        items={[
          { id: 'general', label: 'General' },
          { id: 'providers', label: 'Providers' },
          { id: 'webhooks', label: 'Webhooks' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'general' && (
        <Panel>
          <PanelHeader title="Theme" />
          <PanelBody>
            <div className="flex gap-2">
              {(['auto', 'dark', 'light'] as const).map(t => (
                <Button key={t} variant={theme === t ? 'primary' : 'ghost'} onClick={() => setTheme(t)}>
                  {t}
                </Button>
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}

      {tab === 'providers' && <ProvidersMain />}
      {tab === 'webhooks' && <WebhooksPanel />}
    </div>
  );
}
