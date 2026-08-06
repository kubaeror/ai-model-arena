import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getUser, listUsers, listUserRoles, createUser, deleteUser,
  assignUserRole, removeUserRole,
} from '../lib/api';
import type { ArenaUser } from '../lib/api';
import { Panel, PanelHeader, PanelBody } from './ui/Panel';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/EmptyState';
import { ErrorState } from './ui/ErrorState';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';

const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'forbidden') return 'Administrator access required';
  return msg;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function RoleChip({ role, onRemove, removing }: { role: string; onRemove: () => void; removing: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge value={role} variant={role === 'admin' ? 'tier' : 'status'} />
      <button
        aria-label={`Remove role ${role}`}
        disabled={removing}
        onClick={onRemove}
        className="font-mono text-12 text-fg-1 hover:text-danger disabled:opacity-50"
      >
        ✕
      </button>
    </span>
  );
}

export function UsersPanel() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<Record<string, string>>({});
  const me = getUser();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
    refetchInterval: 30_000,
  });

  const { data: roleData } = useQuery({
    queryKey: ['user-roles'],
    queryFn: listUserRoles,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const createMutation = useMutation({
    mutationFn: () => createUser(newUsername, newPassword),
    onSuccess: () => {
      invalidate();
      setShowCreate(false);
      setNewUsername('');
      setNewPassword('');
      setFormError(null);
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: invalidate,
    onError: (err: Error) => setActionError(err.message),
  });

  const assignMutation = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string }) => assignUserRole(id, roleId),
    onSuccess: () => {
      invalidate();
      setPendingRole({});
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string }) => removeUserRole(id, roleId),
    onSuccess: invalidate,
    onError: (err: Error) => setActionError(err.message),
  });

  if (isLoading) return <div className="p-4 font-mono text-14 text-fg-1">Loading users...</div>;
  if (error) return <ErrorState message={friendlyError(error)} onRetry={() => refetch()} />;

  const users = data ?? [];
  const roles = roleData ?? [];

  const submitCreate = () => {
    if (!newUsername.trim()) {
      setFormError('Username is required');
      return;
    }
    if (!USERNAME_RE.test(newUsername)) {
      setFormError('Username may only contain letters, numbers, underscore, and dash');
      return;
    }
    if (newPassword.length < 8) {
      setFormError('Password must be at least 8 characters');
      return;
    }
    setFormError(null);
    createMutation.mutate();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-20 font-600">Users & Roles</h2>
        <span className="font-mono text-12 text-info border border-info rounded-inner px-2 py-1">
          Administrator only
        </span>
      </div>

      {actionError && (
        <div className="border border-danger text-danger font-mono text-12 px-4 py-2 rounded-inner flex items-center gap-2 bg-danger/5">
          {actionError}
          <button className="underline ml-auto" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      <Panel>
        <PanelHeader title="Users" actions={<Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>New User</Button>} />
        <PanelBody>
          {users.length === 0 ? <EmptyState title="No users" /> : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-14">
                <thead>
                  <tr className="border-b border-border text-left text-fg-1 text-12 uppercase">
                    <th className="py-2 pr-4">Username</th>
                    <th className="py-2 pr-4">Roles</th>
                    <th className="py-2 pr-4">Created</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u: ArenaUser) => {
                    const unassigned = roles.filter(r => !u.roles.includes(r.id));
                    const isSelf = u.username === me;
                    return (
                      <tr key={u.id} className="border-b border-border/50">
                        <td className="py-2 pr-4 text-fg-0">
                          {u.username}
                          {isSelf && <span className="ml-2 text-12 text-info">(you)</span>}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap items-center gap-1">
                            {u.roles.length === 0 && <span className="text-12 text-fg-1">—</span>}
                            {u.roles.map(role => (
                              <RoleChip
                                key={role}
                                role={role}
                                removing={removeMutation.isPending}
                                onRemove={() => {
                                  if (confirm(`Remove role ${role} from ${u.username}?`)) {
                                    removeMutation.mutate({ id: u.id, roleId: role });
                                  }
                                }}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="py-2 pr-4 text-fg-1 text-12">{formatDate(u.created_at)}</td>
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <select
                              aria-label={`Assign role to ${u.username}`}
                              value={pendingRole[u.id] ?? ''}
                              onChange={e => setPendingRole(p => ({ ...p, [u.id]: e.target.value }))}
                              disabled={unassigned.length === 0}
                              className="h-8 rounded-inner border border-border bg-bg-2 px-2 font-mono text-12 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                              <option value="">{unassigned.length === 0 ? 'No roles left' : 'Add role…'}</option>
                              {unassigned.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
                            </select>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!pendingRole[u.id]}
                              onClick={() => {
                                const roleId = pendingRole[u.id];
                                if (roleId) assignMutation.mutate({ id: u.id, roleId });
                              }}
                            >
                              Add
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={isSelf}
                              onClick={() => {
                                if (confirm(`Delete user ${u.username}?`)) deleteMutation.mutate(u.id);
                              }}
                            >
                              {isSelf ? 'Current user' : 'Delete'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </PanelBody>
      </Panel>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create User">
        <div className="flex flex-col gap-4">
          {formError && <p className="text-danger text-sm">{formError}</p>}
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Username</span>
            <Input
              type="text"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
              placeholder="alphanumeric, underscore, dash"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-12 text-fg-1">Password</span>
            <Input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="at least 8 characters"
            />
          </label>
          <div className="flex gap-2 mt-2">
            <Button variant="primary" size="sm" onClick={submitCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
