import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { Button, Card, Input, Field } from '../components/ui.js';

export function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (isAuthenticated) {
    navigate('/');
    return null;
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center">
      <Card className="w-96 p-6">
        <h1 className="text-lg font-semibold mb-1">ai-model-arena</h1>
        <p className="text-muted text-xs mb-1">Sign in to the dashboard</p>
        <form onSubmit={onSubmit} className="space-y-3">
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          {error && <div className="text-red-400 text-xs">{error}</div>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="text-muted text-xs mt-1">
          Credentials come from <code>DASHBOARD_USERNAME</code> / <code>DASHBOARD_PASSWORD</code> in <code>.env</code>. If no password is set, the server prints a generated one at startup.
        </p>
      </Card>
    </div>
  );
}
