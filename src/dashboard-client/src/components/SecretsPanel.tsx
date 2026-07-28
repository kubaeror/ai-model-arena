import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Panel } from './ui/Panel';
import { Input } from './ui/Input';

interface SecretEntry {
  envVar: string;
  status: 'set' | 'missing';
  maskedValue?: string;
}

interface SecretsResponse {
  platform: 'kubernetes' | 'bare-metal';
  secrets: SecretEntry[];
}

const PROVIDER_LABELS: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI',
  ANTHROPIC_API_KEY: 'Anthropic',
  GOOGLE_API_KEY: 'Google',
  OPENROUTER_API_KEY: 'OpenRouter',
  GROQ_API_KEY: 'Groq',
  CEREBRAS_API_KEY: 'Cerebras',
  NVIDIA_API_KEY: 'NVIDIA',
  MISTRAL_API_KEY: 'Mistral',
  SAMBANOVA_API_KEY: 'SambaNova',
  SCALEWAY_API_KEY: 'Scaleway',
  CLOUDFLARE_API_TOKEN: 'Cloudflare',
  GITHUB_TOKEN: 'GitHub Copilot',
  XAI_API_KEY: 'xAI',
};

function providerLabel(envVar: string): string {
  return PROVIDER_LABELS[envVar] ?? envVar;
}

async function fetchSecrets(): Promise<SecretsResponse> {
  const res = await api.get('/api/secrets');
  if (!res.ok) throw new Error('Failed to fetch secrets');
  return res.json();
}

async function setSecret(envVar: string, value: string): Promise<{ ok: boolean }> {
  const res = await api.patch(`/api/secrets/${encodeURIComponent(envVar)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error((err as { error?: string }).error ?? 'Failed to set secret');
  }
  return res.json();
}

async function deleteSecret(envVar: string): Promise<{ ok: boolean }> {
  const res = await api.del(`/api/secrets/${encodeURIComponent(envVar)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error((err as { error?: string }).error ?? 'Failed to delete secret');
  }
  return res.json();
}

export function SecretsPanel() {
  const queryClient = useQueryClient();
  const [editEnvVar, setEditEnvVar] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['secrets'],
    queryFn: fetchSecrets,
    refetchInterval: 30_000,
  });

  const setMutation = useMutation({
    mutationFn: ({ envVar, value }: { envVar: string; value: string }) => setSecret(envVar, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
      setEditEnvVar(null);
      setEditValue('');
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (envVar: string) => deleteSecret(envVar),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (isLoading) return <div className="p-4 font-mono text-14 text-fg-1">Loading secrets...</div>;

  const secrets = data?.secrets ?? [];
  const platform = data?.platform ?? 'bare-metal';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-20 font-600">API Keys</h2>
        {platform === 'kubernetes' && (
          <span className="font-mono text-12 text-info border border-info rounded-inner px-2 py-1">
            Kubernetes — changes sync to cluster Secret
          </span>
        )}
      </div>

      {error && (
        <div className="border border-danger text-danger font-mono text-12 px-4 py-2 rounded-inner flex items-center gap-2 bg-danger/5">
          {error}
          <button className="underline ml-auto" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-14">
            <thead>
              <tr className="border-b border-border text-left text-fg-1 text-12 uppercase">
                <th className="py-2 pr-4">Provider</th>
                <th className="py-2 pr-4">Environ Variable</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Value</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.envVar} className="border-b border-border/50">
                  <td className="py-2 pr-4 text-fg-0">{providerLabel(s.envVar)}</td>
                  <td className="py-2 pr-4 font-mono text-12 text-fg-1">{s.envVar}</td>
                  <td className="py-2 pr-4">
                    {s.status === 'set' ? (
                      <span className="text-accent">✓ Set</span>
                    ) : (
                      <span className="text-warn">✗ Missing</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 font-mono text-12 text-fg-1">
                    {s.maskedValue ?? '—'}
                  </td>
                  <td className="py-2">
                    {editEnvVar === s.envVar ? (
                      <div className="flex items-center gap-2">
                        <Input
                          type="password"
                          placeholder="Enter key..."
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          autoFocus
                          className="w-40"
                        />
                        <button
                          className="font-mono text-12 text-info hover:text-fg-0"
                          onClick={() => setMutation.mutate({ envVar: s.envVar, value: editValue })}
                          disabled={setMutation.isPending}
                        >
                          {setMutation.isPending ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          className="font-mono text-12 text-fg-1 hover:text-fg-0"
                          onClick={() => { setEditEnvVar(null); setEditValue(''); }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          className="font-mono text-12 text-info hover:text-fg-0"
                          onClick={() => { setEditEnvVar(s.envVar); setEditValue(''); }}
                        >
                          {s.status === 'set' ? 'Edit' : 'Set'}
                        </button>
                        {s.status === 'set' && (
                          <button
                            className="font-mono text-12 text-danger hover:text-fg-0"
                            onClick={() => {
                              if (confirm(`Remove ${s.envVar} key?`)) {
                                deleteMutation.mutate(s.envVar);
                              }
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
