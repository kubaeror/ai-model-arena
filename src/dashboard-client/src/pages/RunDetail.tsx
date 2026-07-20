import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useRunLive } from '../hooks/useLive.js';
import { getRun, getConversation, getRunFiles, getRunFile, getRunLogs, stopRun, restartRun, getTrace } from '../lib/api.js';
import { Button, Card, Badge, Select, Spinner } from '../components/ui.js';
import { ConversationView } from '../components/ConversationView.js';
import { CodeEditor } from '../components/CodeEditor.js';
import { TraceWaterfall } from '../components/TraceWaterfall.js';

type Tab = 'conversation' | 'files' | 'logs' | 'trace';

export function RunDetail() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId!;
  const runQuery = useQuery({ queryKey: ['run', runId], queryFn: () => getRun(runId), refetchInterval: 5000 });

  const models = runQuery.data?.run.perModel ?? [];
  const [model, setModel] = useState<string>('');
  const activeModel = model || models[0]?.model || '';
  const [tab, setTab] = useState<Tab>('conversation');

  const live = useRunLive(runId, activeModel);
  const convQuery = useQuery({
    queryKey: ['conversation', runId, activeModel],
    queryFn: () => getConversation(runId, activeModel),
    enabled: !!activeModel,
  });

  const entries = useMemo(
    () => (live.entries.length ? live.entries : convQuery.data?.entries ?? []),
    [live.entries, convQuery.data?.entries],
  );

  const run = runQuery.data?.run;
  const activeEntry = models.find((m) => m.model === activeModel);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{run?.scenario ?? 'Run'}</h1>
          <div className="text-xs text-muted">{runId} · {run?.startedAt ? new Date(run.startedAt).toLocaleString() : ''}</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge color={live.online ? 'green' : run?.status === 'errored' ? 'red' : 'slate'}>{live.online ? 'running' : (run?.status ?? '—')}</Badge>
          <Button size="sm" variant="outline" onClick={() => stopRun(runId)} disabled={!live.online}>Stop</Button>
          <Button size="sm" variant="outline" onClick={() => restartRun(runId)}>Restart</Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-muted">Model:</span>
        <Select value={activeModel} onChange={(e) => setModel(e.target.value)} className="w-64">
          {models.map((m) => (
            <option key={m.model} value={m.model}>{m.model}</option>
          ))}
        </Select>
        {activeEntry && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Badge color={activeEntry.status === 'completed' ? 'slate' : activeEntry.status === 'errored' ? 'red' : 'green'}>{activeEntry.status}</Badge>
            {activeEntry.success === true && <Badge color="green">PASS</Badge>}
            {activeEntry.success === false && <Badge color="red">FAIL</Badge>}
            {activeEntry.turnsUsed != null && <span>turns {activeEntry.turnsUsed}</span>}
            {activeEntry.totalToolCalls != null && <span>· tools {activeEntry.totalToolCalls}</span>}
            {activeEntry.stopReason && <span>· {activeEntry.stopReason}</span>}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-border">
        {(['conversation', 'files', 'logs', 'trace'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm capitalize ${tab === t ? 'border-b-2 border-primary text-foreground' : 'text-muted hover:text-foreground'}`}>{t}</button>
        ))}
      </div>

      {tab === 'conversation' && (
        <Card className="h-[60vh] overflow-auto nice-scroll">
          {runQuery.isLoading ? <div className="p-4 flex gap-2 items-center text-muted text-sm"><Spinner /> Loading…</div> : <ConversationView entries={entries} />}
        </Card>
      )}
      {tab === 'files' && <FilesPanel runId={runId} model={activeModel} />}
      {tab === 'logs' && <LogsPanel runId={runId} model={activeModel} liveLines={live.logLines} />}
      {tab === 'trace' && <TracePanel runId={runId} model={activeModel} />}
    </div>
  );
}

function FilesPanel({ runId, model }: { runId: string; model: string }) {
  const filesQuery = useQuery({
    queryKey: ['run-files', runId, model],
    queryFn: () => getRunFiles(runId, model),
    enabled: !!model,
    refetchInterval: 5000,
  });
  const [selected, setSelected] = useState<string>('');
  const current = selected || filesQuery.data?.[0] || '';
  const fileQuery = useQuery({
    queryKey: ['run-file', runId, model, current],
    queryFn: () => getRunFile(runId, model, current),
    enabled: !!current,
  });

  const lang = (path: string): 'js' | 'json' | 'md' | 'text' => {
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.md')) return 'md';
    if (/\.[mc]?[jt]sx?$/.test(path)) return 'js';
    return 'text';
  };

  return (
    <div className="flex gap-3 h-[60vh]">
      <Card className="w-56 shrink-0 overflow-auto nice-scroll">
        {filesQuery.isLoading ? (
          <div className="p-3 flex gap-2 items-center text-muted text-xs"><Spinner />…</div>
        ) : filesQuery.data && filesQuery.data.length ? (
          filesQuery.data.map((f) => (
            <button key={f} onClick={() => setSelected(f)} className={`block w-full text-left truncate px-3 py-1.5 text-xs ${current === f ? 'bg-primary/20 text-foreground' : 'text-muted hover:bg-muted/10'}`}>{f}</button>
          ))
        ) : (
          <div className="p-3 text-muted text-xs">No files yet.</div>
        )}
      </Card>
      <div className="flex-1 min-w-0">
        {current ? (
          fileQuery.isLoading ? (
            <div className="p-3 flex gap-2 items-center text-muted text-xs"><Spinner /> Loading…</div>
          ) : (
            <CodeEditor value={fileQuery.data ?? ''} readOnly language={lang(current)} height="60vh" />
          )
        ) : (
          <Card className="p-6 text-center text-muted text-sm">Select a file to view its contents.</Card>
        )}
      </div>
    </div>
  );
}

function LogsPanel({ runId, model, liveLines }: { runId: string; model: string; liveLines: string[] }) {
  const logsQuery = useQuery({
    queryKey: ['run-logs', runId, model],
    queryFn: () => getRunLogs(runId, model),
    enabled: !!model,
  });
  const lines = liveLines.length ? liveLines : (logsQuery.data ?? '').split(/\r?\n/).filter(Boolean);
  return (
    <Card className="h-[60vh] overflow-auto nice-scroll">
      <pre className="px-4 py-3 text-xs font-mono whitespace-pre-wrap text-muted">{lines.join('\n') || '(no logs yet)'}</pre>
    </Card>
  );
}

function TracePanel({ runId, model }: { runId: string; model: string }) {
  const traceQuery = useQuery({
    queryKey: ['trace', runId, model],
    queryFn: () => getTrace(runId, model || undefined),
    enabled: !!runId,
    refetchInterval: 5000,
  });
  if (traceQuery.isLoading) {
    return <div className="p-4 flex gap-2 items-center text-muted text-sm"><Spinner /> Loading trace…</div>;
  }
  const trace = traceQuery.data?.traces.find((t) => t.model === model) ?? traceQuery.data?.traces[0];
  return (
    <Card className="h-[60vh] overflow-auto nice-scroll p-4">
      {trace?.externalUrl ? (
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-muted">External trace UI:</span>
          <a className="text-blue-400 hover:underline" href={trace.externalUrl} target="_blank" rel="noreferrer">{trace.externalUrl}</a>
        </div>
      ) : null}
      <TraceWaterfall trace={trace} />
    </Card>
  );
}

