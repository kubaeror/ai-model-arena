import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useRunLive } from '../hooks/useLive.js';
import { getRun, getConversation, getRunFiles, getRunFile, getRunLogs, getRunDiff, stopRun, restartRun, getTrace, type JudgeScoreRow } from '../lib/api.js';
import { PageShell } from '../components/ui/PageShell';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { ConversationView } from '../components/ConversationView.js';
import { CodeEditor } from '../components/CodeEditor.js';
import { TraceWaterfall } from '../components/TraceWaterfall.js';

const TAB_ITEMS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'files', label: 'Files' },
  { id: 'logs', label: 'Logs' },
  { id: 'trace', label: 'Trace' },
  { id: 'diff', label: 'Diff' },
  { id: 'judge', label: 'Judge' },
];

export function RunDetail() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId!;
  const runQuery = useQuery({ queryKey: ['run', runId], queryFn: () => getRun(runId), refetchInterval: 5000 });

  const models = runQuery.data?.run.perModel ?? [];
  const [model, setModel] = useState<string>('');
  const activeModel = model || models[0]?.model || '';
  const [tab, setTab] = useState<string>('conversation');

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
  const modelOptions = models.map(m => ({ value: m.model, label: m.model }));
  const statusLabel = live.online ? 'running' : (run?.status ?? '—');
  const statusTier = live.online ? 'S' : run?.status === 'errored' ? 'C' : 'A';

  return (
    <PageShell
      title={run?.scenario ?? 'Run'}
      description={`${runId} · ${run?.startedAt ? new Date(run.startedAt).toLocaleString() : ''}`}
      breadcrumbs={[{ label: 'Home', to: '/' }, { label: run?.scenario ?? runId }]}
      actions={
        <div className="flex items-center gap-2">
          <Badge variant={statusTier === 'S' ? 'tier' : 'neutral'} value={statusLabel} />
          <Button variant="ghost" size="sm" onClick={() => stopRun(runId)} disabled={!live.online}>Stop</Button>
          <Button variant="ghost" size="sm" onClick={() => restartRun(runId)}>Restart</Button>
          <a href={`/api/export/runs/${encodeURIComponent(runId)}/csv`} download={`${runId}-conversation.csv`}>
            <Button variant="ghost" size="sm">Export CSV</Button>
          </a>
        </div>
      }
    >
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="font-body text-12 text-fg-1">Model:</span>
        <Select
          value={activeModel}
          onChange={setModel}
          options={modelOptions}
          className="w-200"
        />
        {activeEntry && (
          <div className="flex flex-wrap items-center gap-2 font-mono text-12 text-fg-1">
            <Badge variant="status" value={activeEntry.status} />
            {activeEntry.success === true && <Badge variant="success" value="PASS" />}
            {activeEntry.success === false && <Badge variant="failure" value="FAIL" />}
            {activeEntry.turnsUsed != null && <span>turns {activeEntry.turnsUsed}</span>}
            {activeEntry.totalToolCalls != null && <span>· tools {activeEntry.totalToolCalls}</span>}
            {activeEntry.stopReason && <span>· {activeEntry.stopReason}</span>}
          </div>
        )}
      </div>

      <Tabs items={TAB_ITEMS} value={tab} onChange={setTab} />

      {tab === 'conversation' && (
        <Panel className="h-[60vh] overflow-auto nice-scroll">
          {runQuery.isLoading ? <div className="flex gap-2 items-center text-fg-1 text-sm p-4"><Spinner /> Loading…</div> : <ConversationView entries={entries} />}
        </Panel>
      )}
      {tab === 'files' && <FilesPanel runId={runId} model={activeModel} />}
      {tab === 'logs' && <LogsPanel runId={runId} model={activeModel} liveLines={live.logLines} />}
      {tab === 'trace' && <TracePanel runId={runId} model={activeModel} />}
      {tab === 'diff' && <DiffPanel runId={runId} model={activeModel} />}
      {tab === 'judge' && <JudgePanel scores={runQuery.data?.judge ?? []} loading={runQuery.isLoading} />}
    </div>
    </PageShell>
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
      <Panel className="w-56 shrink-0 overflow-auto nice-scroll p-0">
        {filesQuery.isLoading ? (
          <div className="p-3 flex gap-2 items-center text-fg-1 text-xs"><Spinner />…</div>
        ) : filesQuery.data && filesQuery.data.length ? (
          filesQuery.data.map((f) => (
            <button key={f} onClick={() => setSelected(f)} className={`block w-full text-left truncate px-3 py-1.5 font-mono text-12 ${current === f ? 'bg-accent/15 text-accent' : 'text-fg-1 hover:bg-bg-2'}`}>{f}</button>
          ))
        ) : (
          <div className="p-3 text-fg-1 text-xs">No files yet.</div>
        )}
      </Panel>
      <div className="flex-1 min-w-0">
        {current ? (
          fileQuery.isLoading ? (
            <div className="p-3 flex gap-2 items-center text-fg-1 text-xs"><Spinner /> Loading…</div>
          ) : (
            <CodeEditor value={fileQuery.data ?? ''} readOnly language={lang(current)} height="60vh" />
          )
        ) : (
          <Panel className="p-6 text-center text-fg-1 text-sm">Select a file to view its contents.</Panel>
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
    <Panel className="h-[60vh] overflow-auto nice-scroll">
      <pre className="px-4 py-3 font-mono text-12 whitespace-pre-wrap text-fg-1">{lines.join('\n') || '(no logs yet)'}</pre>
    </Panel>
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
    return <div className="p-4 flex gap-2 items-center text-fg-1 text-sm"><Spinner /> Loading trace…</div>;
  }
  const trace = traceQuery.data?.traces.find((t) => t.model === model) ?? traceQuery.data?.traces[0];
  return (
    <Panel className="h-[60vh] overflow-auto nice-scroll p-4">
      <TraceWaterfall trace={trace} />
    </Panel>
  );
}

function DiffPanel({ runId, model }: { runId: string; model: string }) {
  const diffQuery = useQuery({
    queryKey: ['run-diff', runId, model],
    queryFn: () => getRunDiff(runId, model),
    enabled: !!model,
  });
  if (diffQuery.isLoading) {
    return <div className="p-4 flex gap-2 items-center text-fg-1 text-sm"><Spinner /> Loading diff…</div>;
  }
  const diff = diffQuery.data?.diff;
  return (
    <Panel className="h-[60vh] overflow-auto nice-scroll">
      <pre className="px-4 py-3 font-mono text-12 whitespace-pre-wrap text-fg-1">
        {diff || '(no diff available)'}
      </pre>
    </Panel>
    );
}

function JudgePanel({ scores, loading }: { scores: JudgeScoreRow[]; loading: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (loading) {
    return <div className="p-4 flex gap-2 items-center text-fg-1 text-sm"><Spinner /> Loading judge scores…</div>;
  }
  if (scores.length === 0) {
    return (
      <Panel className="p-10 text-center">
        <p className="font-display text-16 text-fg-0">No judge scores</p>
        <p className="mt-1 font-body text-14 text-fg-1">Enable evaluation config to score this run's models.</p>
      </Panel>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {scores.map((s) => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(s.scores_json); } catch { /* keep raw */ }
        const open = expanded === s.model;
        return (
          <Panel key={s.id} className="p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-mono text-14 text-fg-0">{s.model}</span>
              <Badge variant="tier" value={`${s.average_score.toFixed(1)}/100`} />
              <span className="font-body text-12 text-fg-1">judge: {s.judge_model}</span>
              <span className="font-mono text-12 text-fg-1">at {new Date(s.judged_at).toLocaleString()}</span>
              <button
                className="ml-auto font-mono text-12 text-accent hover:underline"
                onClick={() => setExpanded(open ? null : s.model)}
              >
                {open ? 'hide scores' : 'show scores'}
              </button>
            </div>
            <p className="mt-2 font-body text-13 text-fg-1">{s.summary}</p>
            {open && (
              <pre className="mt-3 max-h-56 overflow-auto rounded bg-bg-2 px-3 py-2 font-mono text-12 whitespace-pre-wrap text-fg-1">
                {parsed ? JSON.stringify(parsed, null, 2) : s.scores_json}
              </pre>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
