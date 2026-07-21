import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { useCatalogModels, type CatalogModel, type CatalogModelFilters } from '../hooks/useCatalog';

const PROVIDER_OPTIONS = [
  { value: '', label: 'All providers' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'nvidia', label: 'NVIDIA' },
];

export function Catalog() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<CatalogModelFilters>({});
  const [text, setText] = useState('');
  const { data, isLoading, error, refetch } = useCatalogModels(filters);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!text) return data;
    const q = text.toLowerCase();
    return data.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [data, text]);

  const columns: Column<CatalogModel>[] = [
    { key: 'name', header: 'Name', sortable: true, render: m => <span className="font-mono text-14 text-fg-0">{m.name}</span> },
    { key: 'provider_id', header: 'Provider', sortable: true, render: m => <Badge variant="provider" value={m.provider_id} /> },
    { key: 'context_limit', header: 'Context', sortable: true, render: m => <span data-numeric>{m.context_limit?.toLocaleString() ?? '-'}</span> },
    { key: 'reasoning', header: 'Reason', render: m => m.reasoning ? <Badge variant="reasoning" value="reason" /> : <span className="text-fg-1">-</span> },
    { key: 'tool_call', header: 'Tools', render: m => m.tool_call ? <span className="text-accent">✓</span> : <span className="text-fg-1">-</span> },
    { key: 'input', header: 'In $/M', sortable: true, render: m => <span data-numeric>{m.input != null ? `$${m.input}` : '-'}</span> },
    { key: 'output', header: 'Out $/M', sortable: true, render: m => <span data-numeric>{m.output != null ? `$${m.output}` : '-'}</span> },
    { key: 'cache_read', header: 'Cache $/M', render: m => <span data-numeric className="text-fg-1">{m.cache_read != null ? `$${m.cache_read}` : '-'}</span> },
    { key: 'status', header: 'Status', render: m => m.status ? <Badge variant="status" value={m.status} /> : <span className="text-fg-1">stable</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Catalog</h1>
      <Panel>
        <div className="flex flex-wrap items-center gap-3 pb-4 border-b border-border">
          <Select
            label="Provider"
            value={filters.provider ?? ''}
            onChange={v => setFilters(f => ({ ...f, provider: v || undefined }))}
            options={PROVIDER_OPTIONS}
            className="w-160"
          />
          <Select
            label="Reasoning"
            value={filters.reasoning ?? ''}
            onChange={v => setFilters(f => ({ ...f, reasoning: (v || undefined) as '1' | '0' }))}
            options={[{ value: '', label: 'Any' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' }]}
            className="w-120"
          />
          <Select
            label="Tools"
            value={filters.tool_call ?? ''}
            onChange={v => setFilters(f => ({ ...f, tool_call: (v || undefined) as '1' | '0' }))}
            options={[{ value: '', label: 'Any' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' }]}
            className="w-120"
          />
          <label className="flex flex-col gap-1">
            <span className="font-body text-12 text-fg-1 uppercase">Min context</span>
            <input
              type="number"
              placeholder="0"
              value={filters.min_context ?? ''}
              onChange={e => setFilters(f => ({ ...f, min_context: e.target.value ? Number(e.target.value) : undefined }))}
              className="h-40 w-120 px-3 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-w-200">
            <span className="font-body text-12 text-fg-1 uppercase">Search</span>
            <input
              type="text"
              placeholder="model name or id..."
              value={text}
              onChange={e => setText(e.target.value)}
              className="h-40 px-3 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
        </div>
        {isLoading ? <div className="flex justify-center py-12"><Spinner /></div>
        : error ? <ErrorState message="Failed to load catalog" onRetry={() => refetch()} />
        : <DataTable columns={columns} data={filtered} onRowClick={m => navigate(`/catalog/${encodeURIComponent(m.id)}`)} getRowId={m => m.id} />}
        <div className="pt-2 text-right font-mono text-12 text-fg-1">{filtered.length} models</div>
      </Panel>
    </div>
  );
}
