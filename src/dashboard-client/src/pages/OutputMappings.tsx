import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import {
  listOutputMappings,
  createOutputMapping,
  updateOutputMapping,
  deleteOutputMapping,
  type OutputMappingRow,
} from '../lib/api';

const EMPTY_FORM = { scope: 'global', scopeId: '', parentFolder: '', perModelPattern: '' };

export function OutputMappings() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [deleting, setDeleting] = useState<OutputMappingRow | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const list = useQuery({ queryKey: ['output-mappings'], queryFn: listOutputMappings });

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        scope: form.scope,
        scopeId: form.scopeId,
        parentFolder: form.parentFolder,
        perModelPattern: form.perModelPattern,
      };
      return editingId ? updateOutputMapping(editingId, payload) : createOutputMapping(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['output-mappings'] });
      setModalOpen(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      setFormError('');
    },
    onError: (e) => setFormError((e as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteOutputMapping(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['output-mappings'] });
      setDeleting(null);
      setDeleteError('');
    },
    onError: (e) => setDeleteError((e as Error).message),
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setModalOpen(true);
  };

  const openEdit = (m: OutputMappingRow) => {
    setEditingId(m.id);
    setForm({
      scope: m.scope,
      scopeId: m.scope_id,
      parentFolder: m.parent_folder,
      perModelPattern: m.per_model_pattern,
    });
    setFormError('');
    setModalOpen(true);
  };

  const isEditing = editingId !== null;
  const rows = list.data ?? [];
  const saveDisabled = saveMut.isPending || !form.scopeId.trim() || !form.parentFolder.trim() || !form.perModelPattern.trim();

  return (
    <PageShell
      title="Output Mappings"
      description="Global output location mapping for run results"
      loading={list.isLoading}
    >
      <div className="flex flex-col gap-6">
        <Panel>
          <PanelHeader
            title="Output Location Mappings"
            actions={
              <Button size="sm" variant="primary" onClick={openCreate}>
                <Plus size={14} /> New mapping
              </Button>
            }
          />
          <PanelBody>
            {rows.length === 0 ? (
              <EmptyState title="No mappings configured" description="Defaults to OUTPUT_ROOT/<model>/<runId>" />
            ) : (
              <table className="w-full font-mono text-14">
                <thead>
                  <tr className="text-fg-1 text-12 uppercase border-b border-border">
                    <th className="px-2 py-2 text-left">Scope</th>
                    <th className="px-2 py-2 text-left">Scope ID</th>
                    <th className="px-2 py-2 text-left">Parent Folder</th>
                    <th className="px-2 py-2 text-left">Pattern</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className="border-b border-border/50 hover:bg-bg-2">
                      <td className="px-2 py-2"><Badge variant={m.scope === 'global' ? 'status' : 'neutral'} value={m.scope} /></td>
                      <td className="px-2 py-2">{m.scope_id}</td>
                      <td className="px-2 py-2">{m.parent_folder}</td>
                      <td className="px-2 py-2 font-mono text-12">{m.per_model_pattern}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(m)}><Pencil size={14} /> Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setDeleting(m); setDeleteError(''); }}><Trash2 size={14} /> Delete</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={isEditing ? 'Edit output mapping' : 'New output mapping'}>
        <div className="flex flex-col gap-4">
          <Field label="Scope">
            <select
              aria-label="Scope"
              value={form.scope}
              onChange={(e) => setForm(f => ({ ...f, scope: e.target.value }))}
              className="rounded-inner border border-border bg-bg-0 px-3 py-2 text-14 text-fg-0"
            >
              <option value="global">global</option>
              <option value="model">model</option>
            </select>
          </Field>
          <Field label="Scope ID" hint={form.scope === 'global' ? 'e.g. run-id' : 'Model name, e.g. gpt-4o'}>
            <Input value={form.scopeId} onChange={(e) => setForm(f => ({ ...f, scopeId: e.target.value }))} placeholder="e.g. gpt-4o or run-id" />
          </Field>
          <Field label="Parent folder">
            <Input value={form.parentFolder} onChange={(e) => setForm(f => ({ ...f, parentFolder: e.target.value }))} placeholder="Parent folder (e.g. /outputs/arena)" />
          </Field>
          <Field label="Per-model pattern">
            <Input value={form.perModelPattern} onChange={(e) => setForm(f => ({ ...f, perModelPattern: e.target.value }))} placeholder="Per-model pattern (e.g. {model}/{runId})" />
          </Field>
          {formError && <div className="font-mono text-12 text-danger">{formError}</div>}
          <div className="flex gap-2 mt-2">
            <Button variant="primary" size="sm" onClick={() => saveMut.mutate()} disabled={saveDisabled}>
              {saveMut.isPending ? 'Saving…' : isEditing ? 'Save' : 'Create mapping'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={`Delete mapping "${deleting?.scope_id ?? ''}"?`}>
        <div className="flex flex-col gap-4">
          <p className="text-14 text-fg-1">
            This removes the output mapping for {deleting?.scope ?? ''} scope "{deleting?.scope_id ?? ''}" (pattern {deleting?.per_model_pattern ?? ''}).
          </p>
          {deleteError && <div className="font-mono text-12 text-danger">{deleteError}</div>}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => deleteMut.mutate(deleting!.id)} disabled={deleteMut.isPending}>
              {deleteMut.isPending ? 'Deleting…' : 'Confirm delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </PageShell>
  );
}
