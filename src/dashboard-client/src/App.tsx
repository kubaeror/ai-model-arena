import { NavLink, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import { Activity, AlertTriangle, Boxes, DollarSign, FlaskConical, ListChecks, Play, Settings, Wrench } from 'lucide-react';
import { AuthProvider, useAuth } from './hooks/useAuth.js';
import { LiveProvider } from './hooks/useLive.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { RunDetail } from './pages/RunDetail.js';
import { Scenarios } from './pages/Scenarios.js';
import { Models } from './pages/Models.js';
import { Launcher } from './pages/Launcher.js';
import { Comparisons } from './pages/Comparisons.js';
import { ToolAnalytics } from './pages/ToolAnalytics.js';
import { CostLeaderboard } from './pages/CostLeaderboard.js';
import { Anomalies } from './pages/Anomalies.js';
import { cn } from './lib/cn.js';

const NAV = [
  { to: '/', label: 'Live', icon: Activity },
  { to: '/launch', label: 'Run', icon: Play },
  { to: '/scenarios', label: 'Scenarios', icon: FlaskConical },
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/comparisons', label: 'Comparisons', icon: ListChecks },
  { to: '/analytics', label: 'Analytics', icon: Wrench },
  { to: '/cost', label: 'Cost', icon: DollarSign },
  { to: '/anomalies', label: 'Anomalies', icon: AlertTriangle },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Shell() {
  const { isAuthenticated, logout, username } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Login />;

  return (
    <LiveProvider>
      <div className="flex h-full">
        <aside className="w-56 shrink-0 border-r border-border bg-card flex flex-col">
          <div className="px-4 py-4 font-semibold tracking-tight">ai-model-arena</div>
          <nav className="flex-1 px-2 space-y-0.5">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
                    isActive ? 'bg-primary/20 text-foreground' : 'text-muted hover:bg-muted/10 hover:text-foreground',
                  )
                }
              >
                <n.icon size={16} /> {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="p-3 border-t border-border text-xs text-muted">
            <div>signed in as <span className="text-foreground">{username}</span></div>
            <button className="mt-1 hover:text-foreground" onClick={logout}>Sign out</button>
          </div>
        </aside>
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/launch" element={<Launcher />} />
            <Route path="/scenarios" element={<Scenarios />} />
            <Route path="/models" element={<Models />} />
            <Route path="/comparisons" element={<Comparisons />} />
            <Route path="/analytics" element={<ToolAnalytics />} />
            <Route path="/cost" element={<CostLeaderboard />} />
            <Route path="/anomalies" element={<Anomalies />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace state={{ from: location }} />} />
          </Routes>
        </main>
      </div>
    </LiveProvider>
  );
}

function SettingsPage() {
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-3">Settings</h1>
      <p className="text-muted text-sm">The dashboard reads credentials from your <code className="text-foreground">.env</code>. Set <code className="text-foreground">DASHBOARD_USERNAME</code>, <code className="text-foreground">DASHBOARD_PASSWORD</code>, and (optionally) <code className="text-foreground">DASHBOARD_JWT_SECRET</code> / <code className="text-foreground">DASHBOARD_PORT</code> (default 4000), then restart the server.</p>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
