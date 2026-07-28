import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Input } from '../components/ui/Input';
import { Field } from '../components/ui/Field';

export function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="min-h-screen flex items-center justify-center bg-bg-0">
      <Panel className="w-96 p-6">
        <div className="mb-6 text-center">
          <h1 className="font-display text-28 font-700 text-accent">AI_ARENA</h1>
          <p className="font-body text-14 text-fg-1 mt-1">Sign in to the dashboard</p>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-1 hover:text-fg-0"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          {error && <div className="font-mono text-12 text-danger text-center">{error}</div>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="font-body text-11 text-fg-1 mt-4 text-center">
          Credentials from <code className="font-mono text-accent">DASHBOARD_USERNAME</code> /{' '}
          <code className="font-mono text-accent">DASHBOARD_PASSWORD</code>
        </p>
      </Panel>
    </div>
  );
}
