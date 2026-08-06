import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listNotifications, retryNotification, type NotificationRow } from '../lib/api';
import { Panel } from './ui/Panel';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/EmptyState';

function StatusBadge({ status }: { status: NotificationRow['status'] }) {
  if (status === 'delivered') return <Badge variant="success" value="delivered" />;
  if (status === 'failed') return <Badge variant="failure" value="failed" />;
  return <Badge variant="neutral" value="pending" />;
}

export function NotificationsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, error: queryError } = useQuery({
    queryKey: ['notifications'],
    queryFn: listNotifications,
    refetchInterval: 15_000,
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => retryNotification(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (err: Error) => setError(err.message),
  });

  if (isLoading) return <div className="p-4 font-mono text-14 text-fg-1">Loading notifications...</div>;
  if (isError) return <div className="p-4 font-mono text-14 text-danger">{(queryError as Error).message}</div>;

  const rows = data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-20 font-600">Notifications</h2>
        <span className="font-mono text-12 text-fg-1">
          Delivery outbox — failed sends retry automatically with backoff
        </span>
      </div>

      {error && (
        <div className="border border-danger text-danger font-mono text-12 px-4 py-2 rounded-inner flex items-center gap-2 bg-danger/5">
          {error}
          <button className="underline ml-auto" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No notifications yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-14">
              <thead>
                <tr className="border-b border-border text-left text-fg-1 text-12 uppercase">
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Event</th>
                  <th className="py-2 pr-4">Channel</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">Next / Delivered</th>
                  <th className="py-2 pr-4">Last Error</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((n) => (
                  <tr key={n.id} className="border-b border-border/50">
                    <td className="py-2 pr-4 text-fg-1 text-12">{new Date(n.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-4 text-fg-0">{n.eventType}</td>
                    <td className="py-2 pr-4 text-fg-1">{n.channel}</td>
                    <td className="py-2 pr-4"><StatusBadge status={n.status} /></td>
                    <td className="py-2 pr-4 text-fg-1">{n.attempts}</td>
                    <td className="py-2 pr-4 text-fg-1 text-12">
                      {n.status === 'delivered' && n.deliveredAt
                        ? new Date(n.deliveredAt).toLocaleString()
                        : n.nextAttemptAt
                          ? new Date(n.nextAttemptAt).toLocaleString()
                          : '—'}
                    </td>
                    <td className="py-2 pr-4 text-fg-1 text-12 truncate max-w-[240px]" title={n.lastError ?? undefined}>
                      {n.lastError ?? '—'}
                    </td>
                    <td className="py-2">
                      {n.status === 'failed' && (
                        <button
                          className="font-mono text-12 text-info hover:text-fg-0"
                          onClick={() => retryMutation.mutate(n.id)}
                          disabled={retryMutation.isPending}
                        >
                          {retryMutation.isPending ? 'Retrying...' : 'Retry'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
