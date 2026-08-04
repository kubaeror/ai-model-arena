import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Tabs } from '../components/ui/Tabs';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import {
  getSession, getSessionMessages, getSessionCalls, deleteSession,
} from '../lib/api';

const TAB_ITEMS = [
  { id: 'messages', label: 'Messages' },
  { id: 'calls', label: 'LLM calls' },
];

function jsonOrText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function SessionDetail() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>('messages');

  const sessionQuery = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSession(sessionId),
    retry: false,
  });
  const messagesQuery = useQuery({
    queryKey: ['session-messages', sessionId],
    queryFn: () => getSessionMessages(sessionId),
    enabled: tab === 'messages',
  });
  const callsQuery = useQuery({
    queryKey: ['session-calls', sessionId],
    queryFn: () => getSessionCalls(sessionId),
    enabled: tab === 'calls',
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      navigate('/sessions');
    },
  });

  if (sessionQuery.isLoading) {
    return <PageShell title="Session"><div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading…</div></PageShell>;
  }
  if (!sessionQuery.data) {
    return <PageShell title="Session"><EmptyState title="Session not found" /></PageShell>;
  }
  const session = sessionQuery.data;

  return (
    <PageShell
      title={`Session ${session.id.slice(0, 16)}…`}
      description={`${session.model ?? '?'} · ${session.status} · ${session.message_count} messages · ${session.call_count} calls`}
      breadcrumbs={[{ label: 'Home', to: '/' }, { label: 'Sessions', to: '/sessions' }, { label: session.id.slice(0, 16) }]}
      actions={
        <>
          <Badge variant="status" value={session.status} />
          <Button variant="danger" size="sm" onClick={() => { if (confirm('Delete this session and all its messages?')) deleteMutation.mutate(); }} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      <Tabs items={TAB_ITEMS} value={tab} onChange={setTab} />

      {tab === 'messages' && (
        <Panel className="h-[65vh] overflow-auto nice-scroll">
          <PanelBody>
            {messagesQuery.isLoading ? (
              <div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading…</div>
            ) : (messagesQuery.data?.length ?? 0) === 0 ? (
              <EmptyState title="No messages" />
            ) : (
              <div className="flex flex-col gap-2 font-mono text-12">
                {(messagesQuery.data ?? []).map((m) => (
                  <div key={String(m.id)} className="rounded-inner border border-border/50 p-2">
                    <div className="flex gap-2 text-fg-1">
                      <span className="text-accent">[{String(m.role)}]</span>
                      <span>turn {String(m.turn)}</span>
                      {m.tool_call_id ? <span>tool:{String(m.tool_name ?? m.tool_call_id).slice(0, 40)}</span> : null}
                    </div>
                    {m.content ? <pre className="mt-1 whitespace-pre-wrap text-fg-0">{jsonOrText(m.content)}</pre> : null}
                    {m.tool_calls ? <pre className="mt-1 whitespace-pre-wrap text-fg-1">{jsonOrText(m.tool_calls)}</pre> : null}
                  </div>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
      )}

      {tab === 'calls' && (
        <Panel className="h-[65vh] overflow-auto nice-scroll">
          <PanelBody>
            {callsQuery.isLoading ? (
              <div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading…</div>
            ) : (callsQuery.data?.length ?? 0) === 0 ? (
              <EmptyState title="No model calls recorded" />
            ) : (
              <table className="w-full font-mono text-12">
                <thead>
                  <tr className="border-b border-border text-left text-fg-1 text-12 uppercase">
                    <th className="py-2 pr-4">Turn</th>
                    <th className="py-2 pr-4">Provider</th>
                    <th className="py-2 pr-4">Model</th>
                    <th className="py-2 pr-4">Latency</th>
                    <th className="py-2">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {(callsQuery.data ?? []).map((c) => (
                    <tr key={String(c.id)} className="border-b border-border/50 align-top">
                      <td className="py-2 pr-4 text-accent">{String(c.turn)}</td>
                      <td className="py-2 pr-4 text-fg-1">{String(c.provider)}</td>
                      <td className="py-2 pr-4 text-fg-1">{String(c.model)}</td>
                      <td className="py-2 pr-4 text-fg-1" data-numeric>{c.latency_ms != null ? `${c.latency_ms}ms` : '—'}</td>
                      <td className="py-2 text-fg-1 whitespace-pre-wrap max-w-400">{String(c.response_text ?? '').slice(0, 2000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </PanelBody>
        </Panel>
      )}
    </PageShell>
  );
}
