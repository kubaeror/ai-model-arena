import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAnomalies, resolveAnomaly } from '../lib/api.js';
import type { AnomalyRecord, AnomalySeverity } from '../lib/types.js';
import { PageShell } from '../components/ui/PageShell';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';

const SEVERITY_COLOR_MAP: Record<AnomalySeverity, 'failure' | 'reasoning' | 'neutral'> = {
  critical: 'failure',
  high: 'failure',
  medium: 'reasoning',
  low: 'neutral',
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
    <PageShell
      title="Anomalies"
      description={`${anomalies.length} shown — auto-detected every 5 minutes`}
      loading={query.isLoading}
    >
      <Panel className="p-3 flex flex-wrap gap-2 items-center">
        <Select
          label="Type"
          value={type}
          onChange={setType}
          options={[{ value: '', label: 'All types' }, ...TYPES.map(t => ({ value: t, label: t }))]}
        />
        <Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={[{ value: '', label: 'All severities' }, ...SEVERITIES.map(s => ({ value: s, label: s }))]}
        />
        <Select
          label="State"
          value={resolved}
          onChange={setResolved}
          options={[
            { value: '', label: 'Any state' },
            { value: 'false', label: 'Unresolved' },
            { value: 'true', label: 'Resolved' },
          ]}
        />
        <label className="flex flex-col gap-1 mt-2 w-40">
          <span className="font-body text-12 text-fg-1 uppercase">Model</span>
          <input
            className="h-40 px-3 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            placeholder="filter model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
      </Panel>

      <Panel className="overflow-auto nice-scroll">
        {anomalies.length === 0 ? (
          <div className="p-6 text-center">
            <p className="font-display text-20 text-fg-1">No anomalies match these filters.</p>
          </div>
        ) : (
          <table className="w-full text-14">
            <thead className="font-mono text-12 uppercase text-fg-1 border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-500">Severity</th>
                <th className="text-left px-3 py-2 font-500">Type</th>
                <th className="text-left px-3 py-2 font-500">Model</th>
                <th className="text-left px-3 py-2 font-500">Run</th>
                <th className="text-left px-3 py-2 font-500">Description</th>
                <th className="text-left px-3 py-2 font-500">Detected</th>
                <th className="text-left px-3 py-2 font-500">State</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a: AnomalyRecord) => (
                <tr key={a.id} className="border-b border-border/50 hover:bg-bg-2">
                  <td className="px-3 py-2">
                    <Badge variant={SEVERITY_COLOR_MAP[a.severity]}>{a.severity}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-12">{a.type}</td>
                  <td className="px-3 py-2 text-14">{a.model}</td>
                  <td className="px-3 py-2 text-12 text-fg-1 truncate max-w-[12rem]">
                    <a className="hover:underline text-accent" href={`#/runs/${a.run_id}`}>{a.run_id}</a>
                  </td>
                  <td className="px-3 py-2 text-12 max-w-md">{a.description}</td>
                  <td className="px-3 py-2 text-12 text-fg-1">{new Date(a.detected_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    {a.resolved ? <Badge variant="success">{a.resolved_as ?? 'resolved'}</Badge> : <Badge variant="failure">open</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!a.resolved && (
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="sm" onClick={async () => { await resolveAnomaly(a.id, 'resolved'); void qc.invalidateQueries({ queryKey: ['anomalies'] }); }}>Resolve</Button>
                        <Button variant="ghost" size="sm" onClick={async () => { await resolveAnomaly(a.id, 'false_positive'); void qc.invalidateQueries({ queryKey: ['anomalies'] }); }}>False positive</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </PageShell>
  );
}
