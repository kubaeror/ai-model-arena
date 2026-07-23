import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
  const res = await fetch('/api/secrets');
  if (!res.ok) throw new Error('Failed to fetch secrets');
  return res.json();
}

async function setSecret(envVar: string, value: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/secrets/${encodeURIComponent(envVar)}`, {
    method: 'PUT',
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
  const res = await fetch(`/api/secrets/${encodeURIComponent(envVar)}`, {
    method: 'DELETE',
  });
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

  if (isLoading) return <div className="p-4 text-gray-400">Loading secrets...</div>;

  const secrets = data?.secrets ?? [];
  const platform = data?.platform ?? 'bare-metal';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">API Keys</h2>
        {platform === 'kubernetes' && (
          <span className="text-xs bg-blue-900 text-blue-300 px-2 py-1 rounded">
            Kubernetes — changes sync to cluster Secret
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 px-4 py-2 rounded text-sm">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left text-gray-400">
              <th className="py-2 pr-4">Provider</th>
              <th className="py-2 pr-4">Environ Variable</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Value</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.envVar} className="border-b border-gray-800">
                <td className="py-2 pr-4 text-gray-200">{providerLabel(s.envVar)}</td>
                <td className="py-2 pr-4 font-mono text-xs text-gray-400">{s.envVar}</td>
                <td className="py-2 pr-4">
                  {s.status === 'set' ? (
                    <span className="text-green-400">✓ Set</span>
                  ) : (
                    <span className="text-yellow-400">✗ Missing</span>
                  )}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-gray-500">
                  {s.maskedValue ?? '—'}
                </td>
                <td className="py-2 space-x-2">
                  {editEnvVar === s.envVar ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white w-40"
                        placeholder="Enter key..."
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        autoFocus
                      />
                      <button
                        className="text-blue-400 hover:text-blue-300 text-xs"
                        onClick={() => setMutation.mutate({ envVar: s.envVar, value: editValue })}
                        disabled={setMutation.isPending}
                      >
                        {setMutation.isPending ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        className="text-gray-400 hover:text-gray-300 text-xs"
                        onClick={() => { setEditEnvVar(null); setEditValue(''); }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className="text-blue-400 hover:text-blue-300 text-xs"
                        onClick={() => { setEditEnvVar(s.envVar); setEditValue(''); }}
                      >
                        {s.status === 'set' ? 'Edit' : 'Set'}
                      </button>
                      {s.status === 'set' && (
                        <button
                          className="text-red-400 hover:text-red-300 text-xs"
                          onClick={() => {
                            if (confirm(`Remove ${s.envVar} key?`)) {
                              deleteMutation.mutate(s.envVar);
                            }
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
