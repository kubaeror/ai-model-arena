import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './ui/Modal';
import { Select } from './ui/Select';
import { Button } from './ui/Button';
import { useCatalogModels } from '../hooks/useCatalog';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Scenario {
  name: string;
  description?: string;
}

interface LauncherProps {
  open: boolean;
  onClose: () => void;
}

export function Launcher({ open, onClose }: LauncherProps) {
  const navigate = useNavigate();
  const [scenario, setScenario] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const { data: models } = useCatalogModels({ tool_call: '1' });
  const { data: scenarios } = useQuery({
    queryKey: ['scenarios'],
    queryFn: async () => (await api.get<{ data: Scenario[] }>('/api/scenarios')).json() as Promise<{ data: Scenario[] }>,
  });
  const [submitting, setSubmitting] = useState(false);

  async function handleLaunch() {
    if (!scenario || selectedModels.length === 0) return;
    setSubmitting(true);
    try {
      const res = await api.post('/api/runs', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, models: selectedModels }),
      });
      const data = await res.json() as { runId: string };
      onClose();
      navigate(`/runs/${data.runId}`);
    } finally {
      setSubmitting(false);
    }
  }

  function toggleModel(name: string) {
    setSelectedModels(prev => prev.includes(name) ? prev.filter(m => m !== name) : [...prev, name]);
  }

  return (
    <Modal open={open} onClose={onClose} title="Launch Run">
      <div className="flex flex-col gap-16">
        <Select
          label="Scenario"
          value={scenario}
          onChange={setScenario}
          options={(scenarios?.data ?? []).map(s => ({ value: s.name, label: s.name }))}
        />
        <div>
          <span className="font-body text-12 text-fg-1 uppercase">Models</span>
          <div className="mt-8 max-h-200 overflow-y-auto rounded-inner border border-border p-8">
            {(models ?? []).map(m => (
              <label key={m.id} className="flex items-center gap-8 py-4 hover:bg-bg-2 px-8 rounded-inner">
                <input
                  type="checkbox"
                  checked={selectedModels.includes(m.name)}
                  onChange={() => toggleModel(m.name)}
                  className="accent-accent"
                />
                <span className="font-mono text-14">{m.name}</span>
                <span className="font-body text-12 text-fg-1">— {m.provider_id}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-8">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleLaunch} disabled={!scenario || selectedModels.length === 0 || submitting}>
            Launch
          </Button>
        </div>
      </div>
    </Modal>
  );
}
