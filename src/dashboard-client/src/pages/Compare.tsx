import { useState } from 'react';
import { Panel } from '../components/ui/Panel';
import { Select } from '../components/ui/Select';
import { EmptyState } from '../components/ui/EmptyState';
import { useCatalogModels, type CatalogModel } from '../hooks/useCatalog';
import { useBenchmarks } from '../hooks/useCatalog';
import { Badge } from '../components/ui/Badge';

function ModelColumn({ model, benchmarks }: { model: CatalogModel; benchmarks: ReturnType<typeof useBenchmarks>['data'] }) {
  const modelBenchmarks = (benchmarks ?? []).filter(b => b.model_id === model.id);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-display text-20 font-600">{model.name}</h3>
      <Badge variant="provider" value={model.provider_id} />
      <div className="font-mono text-14">
        <div>Context: <span className="text-fg-0">{model.context_limit?.toLocaleString() ?? '-'}</span></div>
        <div>Input: <span className="text-fg-0">${model.input ?? '-'}</span></div>
        <div>Output: <span className="text-fg-0">${model.output ?? '-'}</span></div>
        <div>Cache: <span className="text-fg-0">${model.cache_read ?? '-'}</span></div>
        <div>Reasoning: <span className="text-accent">{model.reasoning ? 'yes' : 'no'}</span></div>
      </div>
      {modelBenchmarks.length > 0 && (
        <div className="mt-2">
          <div className="font-body text-12 text-fg-1 uppercase mb-1">Benchmarks</div>
          {modelBenchmarks.filter(b => b.is_preferred).map(b => (
            <div key={b.benchmark} className="flex justify-between font-mono text-12 py-2">
              <span className="text-fg-1">{b.benchmark}</span>
              <span className="text-accent" data-numeric>{b.score.toFixed(1)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Compare() {
  const { data: models } = useCatalogModels();
  const { data: benchmarks } = useBenchmarks();
  const [selected, setSelected] = useState<string[]>(['', '', '', '']);

  const modelOptions = (models ?? []).map(m => ({ value: m.id, label: m.name }));
  const selectedModels = selected
    .map(id => (models ?? []).find(m => m.id === id))
    .filter((m): m is CatalogModel => !!m);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Compare</h1>
      <div className="grid grid-cols-4 gap-3">
        {selected.map((id, i) => (
          <Select
            key={i}
            value={id}
            onChange={v => setSelected(prev => prev.map((s, idx) => idx === i ? v : s))}
            options={[{ value: '', label: '— select —' }, ...modelOptions]}
          />
        ))}
      </div>
      <Panel>
        {selectedModels.length < 2 ? (
          <EmptyState title="Pick 2-4 models to compare" description="Select models from the dropdowns above." />
        ) : (
          <div className={`grid gap-4 grid-cols-${selectedModels.length}`}>
            {selectedModels.map(m => <ModelColumn key={m.id} model={m} benchmarks={benchmarks} />)}
          </div>
        )}
      </Panel>
    </div>
  );
}
