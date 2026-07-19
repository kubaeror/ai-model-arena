import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import type { ScenarioConfig, StarterFile } from '../lib/types.js';
import { createScenario, updateScenario } from '../lib/api.js';
import { Button, Card, Field, Input, Textarea, Label, Badge } from './ui.js';
import { CodeEditor } from './CodeEditor.js';

interface Props {
  initial?: { scenario: ScenarioConfig; starterFiles: StarterFile[] };
  onSaved: () => void;
  onCancel: () => void;
}

const EMPTY_FILE: StarterFile = { path: 'src/server.js', content: '' };

export function ScenarioForm({ initial, onSaved, onCancel }: Props) {
  const qc = useQueryClient();
  const sc = initial?.scenario;
  const [name, setName] = useState(sc?.name ?? '');
  const [description, setDescription] = useState(sc?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(sc?.systemPrompt ?? '');
  const [task, setTask] = useState(sc?.task ?? '');
  const [cmd, setCmd] = useState(sc?.successCriteria?.command ?? 'npm test');
  const [exitCode, setExitCode] = useState(String(sc?.successCriteria?.expectedExitCode ?? 0));
  const [contains, setContains] = useState(sc?.successCriteria?.expectedOutputContains ?? '');
  const [maxTurns, setMaxTurns] = useState(String(sc?.maxTurns ?? 25));
  const [files, setFiles] = useState<StarterFile[]>(initial?.starterFiles?.length ? initial.starterFiles : []);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Partial<ScenarioConfig> & { name: string } = {
        name,
        description: description || undefined,
        systemPrompt,
        task,
        maxTurns: Number(maxTurns) || undefined,
        successCriteria: {
          command: cmd || undefined,
          expectedExitCode: Number(exitCode) || 0,
          expectedOutputContains: contains || undefined,
        },
      };
      const starterFilesContent = files.length ? files : undefined;
      if (initial) await updateScenario(sc!.name, payload, starterFilesContent);
      else await createScenario(payload, starterFilesContent);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenarios'] });
      onSaved();
    },
  });

  const updateFile = (i: number, patch: Partial<StarterFile>) => {
    setFiles((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  };

  return (
    <Card className="p-5 max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{initial ? 'Edit scenario' : 'New scenario'}</h2>
        {initial && <Badge>{sc?.name}</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-task" /></Field>
        <Field label="Max turns"><Input value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} type="number" /></Field>
      </div>
      <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="System prompt"><Textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} /></Field>
      <Field label="Task (initial user prompt)"><Textarea rows={5} value={task} onChange={(e) => setTask(e.target.value)} /></Field>

      <div className="border-t border-border pt-4">
        <div className="text-sm font-medium mb-2">Success criteria</div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Command"><Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm test" /></Field>
          <Field label="Expected exit code"><Input value={exitCode} onChange={(e) => setExitCode(e.target.value)} type="number" /></Field>
          <Field label="Output contains (optional)"><Input value={contains} onChange={(e) => setContains(e.target.value)} placeholder="pass" /></Field>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">Starter files (seeded into each sandbox)</div>
          <Button size="sm" variant="outline" onClick={() => setFiles((f) => [...f, { ...EMPTY_FILE }])}><Plus size={14} /> Add file</Button>
        </div>
        {files.length === 0 && <div className="text-muted text-xs">No starter files — the agent starts in an empty workspace.</div>}
        <div className="space-y-4">
          {files.map((f, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <Input value={f.path} onChange={(e) => updateFile(i, { path: e.target.value })} placeholder="src/server.js" className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setFiles((arr) => arr.filter((_, idx) => idx !== i))}><Trash2 size={14} /></Button>
              </div>
              <CodeEditor value={f.content} onChange={(v) => updateFile(i, { content: v })} language={f.path.endsWith('.json') ? 'json' : 'js'} height="220px" />
            </div>
          ))}
        </div>
      </div>

      {mutation.isError && <div className="text-red-400 text-sm">{(mutation.error as Error)?.message}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name || !systemPrompt || !task}>
          {mutation.isPending ? 'Saving…' : initial ? 'Save changes' : 'Create scenario'}
        </Button>
      </div>
    </Card>
  );
}
