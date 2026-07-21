import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAnomalies, resolveAnomaly } from '../lib/api.js';
import type { AnomalyRecord, AnomalySeverity } from '../lib/types.js';
import { Badge, Card, Spinner } from '../components/ui.js';

const SEVERITY_COLOR: Record<AnomalySeverity, 'red' | 'yellow' | 'slate'> = {
  critical: 'red',
  high: 'red',
  medium: 'yellow',
  low: 'slate',
};

const TYPES = ['latency', 'loop', 'token_spike', 'cost_spike', 'error_rate', 'silent_failure'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export function Anomalies() {
  const qc = useQueryClient();
  const [model, setModel] = useState('');
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const [resolved, setResolved] = useState('');

  const params: Parameters<typeof listAnomalies>[0] = {};
  if (model) params.model = model;
  if (type) params.type = type;
  if (severity) params.severity = severity;
  if (resolved === 'true') params.resolved = true;
  if (resolved === 'false') params.resolved = false;
  params.limit = 200;

  const query = useQuery({
    queryKey: ['anomalies', model, type, severity, resolved],
    queryFn: () => listAnomalies(params),
    refetchInterval: 10_000,
  });

  const anomalies = query.data ?? [];

  return (
    <div className="p-6 space-y-1">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Anomalies</h1>
        <span className="text-xs text-muted">{anomalies.length} shown</span>
      </div>

      <Card className="p-3 flex flex-wrap gap-2 items-center text-xs">
        <input
          className="px-2 py-1 bg-card border border-border rounded w-40"
          placeholder="filter model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <select className="px-2 py-1 bg-card border border-border rounded" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="px-2 py-1 bg-card border border-border rounded" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">all severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="px-2 py-1 bg-card border border-border rounded" value={resolved} onChange={(e) => setResolved(e.target.value)}>
          <option value="">any state</option>
          <option value="false">unresolved</option>
          <option value="true">resolved</option>
        </select>
      </Card>

      <Card className="overflow-auto nice-scroll">
        {query.isLoading ? (
          <div className="p-1 flex gap-2 items-center text-muted text-sm"><Spinner /> Loading…</div>
        ) : anomalies.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">No anomalies match these filters.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted border-b border-border">
              <tr>
                <th className="text-left px-3 py-2">Severity</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Model</th>
                <th className="text-left px-3 py-2">Run</th>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-left px-3 py-2">Detected</th>
                <th className="text-left px-3 py-2">State</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a: AnomalyRecord) => (
                <tr key={a.id} className="border-b border-border/50 hover:bg-muted/5">
                  <td className="px-3 py-2"><Badge color={SEVERITY_COLOR[a.severity]}>{a.severity}</Badge></td>
                  <td className="px-3 py-2 font-mono text-xs">{a.type}</td>
                  <td className="px-3 py-2">{a.model}</td>
                  <td className="px-3 py-2 text-xs text-muted truncate max-w-[12rem]"><a className="hover:underline" href={`#/runs/${a.run_id}`}>{a.run_id}</a></td>
                  <td className="px-3 py-2 text-xs max-w-md">{a.description}</td>
                  <td className="px-3 py-2 text-xs text-muted">{new Date(a.detected_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    {a.resolved ? <Badge color="green">{a.resolved_as ?? 'resolved'}</Badge> : <Badge color="red">open</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!a.resolved && (
                      <div className="flex gap-1 justify-end">
                        <button className="text-xs px-2 py-1 rounded border border-border hover:bg-muted/10" onClick={async () => { await resolveAnomaly(a.id, 'resolved'); void qc.invalidateQueries({ queryKey: ['anomalies'] }); }}>Resolve</button>
                        <button className="text-xs px-2 py-1 rounded border border-border hover:bg-muted/10" onClick={async () => { await resolveAnomaly(a.id, 'false_positive'); void qc.invalidateQueries({ queryKey: ['anomalies'] }); }}>False positive</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
