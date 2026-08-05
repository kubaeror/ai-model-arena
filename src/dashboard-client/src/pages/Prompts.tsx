import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Play, Trash2 } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Textarea } from '../components/ui/Textarea';
import {
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  listPromptVersions,
  enqueuePrompt,
  listScenarios,
  listModels,
  type PromptRow,
} from '../lib/api';

const EMPTY_FORM = { name: '', description: '', systemPrompt: '', task: '', tag: '' };

export function Prompts() {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '' });
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [enqueueFor, setEnqueueFor] = useState<PromptRow | null>(null);
  const [enqueueScenario, setEnqueueScenario] = useState('');
  const [enqueueModels, setEnqueueModels] = useState('');
  const [enqueueVersion, setEnqueueVersion] = useState('');
  const [enqueueError, setEnqueueError] = useState('');

  const list = useQuery({ queryKey: ['prompts'], queryFn: listPrompts });

  const versionsQuery = useQuery({
    queryKey: ['prompt-versions', versionsFor ?? ''],
    queryFn: () => listPromptVersions(versionsFor!),
    enabled: !!versionsFor,
  });

  const scenarios = useQuery({ queryKey: ['scenarios'], queryFn: listScenarios });
  const models = useQuery({ queryKey: ['models'], queryFn: listModels });

  const enqueueVersions = useQuery({
    queryKey: ['prompt-versions', enqueueFor?.id ?? ''],
    queryFn: () => listPromptVersions(enqueueFor!.id),
    enabled: !!enqueueFor,
  });

  const createMut = useMutation({
    mutationFn: () => createPrompt({
      name: form.name,
      description: form.description || undefined,
      systemPrompt: form.systemPrompt,
      task: form.task,
      tag: form.tag || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      setForm(EMPTY_FORM);
      setFormError('');
    },
    onError: (e) => setFormError((e as Error).message),
  });

  const updateMut = useMutation({
    mutationFn: () => updatePrompt(editingId!, {
      name: editForm.name,
      description: editForm.description || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      setEditingId(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePrompt(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts'] }),
  });

  const enqueueMut = useMutation({
    mutationFn: () => enqueuePrompt({
      promptId: enqueueFor!.id,
      promptVersion: Number(enqueueVersion) || undefined,
      models: enqueueModels.split(',').map(m => m.trim()).filter(Boolean),
      scenario: enqueueScenario,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      setEnqueueFor(null);
      setEnqueueScenario('');
      setEnqueueModels('');
      setEnqueueError('');
    },
    onError: (e) => setEnqueueError((e as Error).message),
  });

  const openEnqueue = (p: PromptRow) => {
    setEnqueueFor(p);
    setEnqueueScenario('');
    setEnqueueModels('');
    setEnqueueVersion(String(p.latest_version ?? ''));
    setEnqueueError('');
  };

  const startEdit = (p: PromptRow) => {
    setEditingId(p.id);
    setEditForm({ name: p.name, description: p.description ?? '' });
  };

  const versions = versionsQuery.data ?? [];
  const effectiveVersion = selectedVersion ?? String(versions[0]?.version ?? '');
  const versionDetail = versions.find(v => String(v.version) === effectiveVersion);

  const enqueueVersionOptions = (enqueueVersions.data ?? []).map(v => (
    <option key={v.version} value={String(v.version)}>
      v{v.version}{v.tag ? ` · ${v.tag}` : ''}
    </option>
  ));

  return (
    <PageShell
      title="Prompts"
      description="System prompts and task templates for agent runs"
      loading={list.isLoading}
    >
      <div className="flex flex-col gap-6">
        <Panel>
          <PanelHeader title="New Prompt" />
          <PanelBody className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-1">
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="prompt-name" /></Field>
              <Field label="Description (optional)"><Input value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Description (optional)" /></Field>
            </div>
            <Field label="System prompt"><Textarea rows={4} value={form.systemPrompt} onChange={(e) => setForm(f => ({ ...f, systemPrompt: e.target.value }))} placeholder="You are a helpful agent that..." /></Field>
            <Field label="Task"><Textarea rows={5} value={form.task} onChange={(e) => setForm(f => ({ ...f, task: e.target.value }))} placeholder="Implement the feature..." /></Field>
            <Field label="Tag (optional)"><Input value={form.tag} onChange={(e) => setForm(f => ({ ...f, tag: e.target.value }))} placeholder="tag (optional)" /></Field>
            {formError && <div className="font-mono text-12 text-danger">{formError}</div>}
            <div className="flex justify-end">
              <Button
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending || !form.name || !form.systemPrompt || !form.task}
              >
                {createMut.isPending ? 'Creating…' : 'Create prompt'}
              </Button>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="All Prompts" />
          <PanelBody>
            {!list.data || list.data.length === 0 ? (
              <EmptyState title="No prompts yet" description="Prompts define the system prompt and task for agent runs." />
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {list.data.map((p) => (
                  <div key={p.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-display text-16 font-600">{p.name}</h3>
                          {p.latest_tag && <Badge variant="neutral" value={p.latest_tag} />}
                          {p.latest_version !== null && (
                            <Badge variant="status" value={`v${p.latest_version}`} />
                          )}
                        </div>
                        {p.description && <p className="text-fg-1 text-12">{p.description}</p>}
                        <span className="font-mono text-12 text-fg-1">{new Date(p.updated_at).toLocaleDateString()}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button size="sm" variant="ghost" onClick={() => setVersionsFor(versionsFor === p.id ? null : p.id)}>
                          <Layers size={14} /> Versions
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => startEdit(p)}><Pencil size={14} /> Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteMut.mutate(p.id)}><Trash2 size={14} /> Delete</Button>
                        <Button size="sm" variant="primary" onClick={() => openEnqueue(p)}><Play size={14} /> Enqueue</Button>
                      </div>
                    </div>

                    {editingId === p.id && (
                      <div className="flex flex-col gap-2 mt-3 border border-border rounded-panel p-3">
                        <div className="grid grid-cols-2 gap-1">
                          <Field label="Name"><Input value={editForm.name} onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))} placeholder="Prompt name" /></Field>
                          <Field label="Description"><Input value={editForm.description} onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))} placeholder="Description" /></Field>
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                          <Button size="sm" onClick={() => updateMut.mutate()} disabled={updateMut.isPending || !editForm.name}>
                            {updateMut.isPending ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                      </div>
                    )}

                    {versionsFor === p.id && (
                      <div className="flex flex-col gap-2 mt-3 border border-border rounded-panel p-3">
                        <div className="flex items-center gap-2">
                          <label className="text-12 text-fg-1">Version</label>
                          <select
                            value={effectiveVersion}
                            onChange={(e) => setSelectedVersion(e.target.value)}
                            className="h-32 px-3 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0"
                          >
                            {versionsQuery.isLoading && <option value="">Loading…</option>}
                            {versions.map(v => (
                              <option key={v.version} value={String(v.version)}>
                                v{v.version}{v.tag ? ` · ${v.tag}` : ''}
                              </option>
                            ))}
                          </select>
                          {versionDetail?.tag && <Badge variant="neutral" value={versionDetail.tag} />}
                        </div>
                        {versionDetail && (
                          <div className="flex flex-col gap-2 text-14">
                            <div>
                              <div className="text-12 text-fg-1 uppercase">System prompt</div>
                              <pre className="font-mono text-13 whitespace-pre-wrap bg-bg-0 rounded-inner p-2">{versionDetail.system_prompt}</pre>
                            </div>
                            <div>
                              <div className="text-12 text-fg-1 uppercase">Task</div>
                              <pre className="font-mono text-13 whitespace-pre-wrap bg-bg-0 rounded-inner p-2">{versionDetail.task}</pre>
                            </div>
                            <div className="font-mono text-12 text-fg-1">
                              created by {versionDetail.created_by} on {new Date(versionDetail.created_at).toLocaleString()}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Modal open={!!enqueueFor} onClose={() => setEnqueueFor(null)} title={`Enqueue "${enqueueFor?.name ?? ''}"`}>
        <div className="flex flex-col gap-4">
          {enqueueError && <p className="text-danger text-sm">{enqueueError}</p>}
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Scenario</span>
            <select
              value={enqueueScenario}
              onChange={e => setEnqueueScenario(e.target.value)}
              className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0"
            >
              <option value="">Select...</option>
              {(scenarios.data ?? []).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Models (comma-separated)</span>
            <input
              type="text"
              value={enqueueModels}
              onChange={e => setEnqueueModels(e.target.value)}
              className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0"
              placeholder="gpt-4o, claude-3.7"
            />
            {models.data && models.data.length > 0 && (
              <span className="text-11 text-fg-1">Available: {models.data.map(m => m.name).join(', ')}</span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Prompt version (default: latest)</span>
            <select
              value={enqueueVersion}
              onChange={e => setEnqueueVersion(e.target.value)}
              className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0"
            >
              {(enqueueVersions.data ?? []).length > 0
                ? enqueueVersionOptions
                : <option value={String(enqueueFor?.latest_version ?? '')}>latest</option>}
            </select>
          </label>
          <div className="flex gap-2 mt-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => enqueueMut.mutate()}
              disabled={enqueueMut.isPending || !enqueueScenario || !enqueueModels.trim()}
            >
              {enqueueMut.isPending ? 'Queueing…' : 'Queue run'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEnqueueFor(null)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </PageShell>
  );
}
