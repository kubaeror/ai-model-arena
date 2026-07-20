import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { LiveProvider } from './hooks/useLive';
import { SettingsProvider } from './providers/SettingsProvider';
import { Nav } from './components/Nav';
import { Home } from './pages/Home';
import { Catalog } from './pages/Catalog';
import { ModelDetail } from './pages/ModelDetail';
import { Leaderboard } from './pages/Leaderboard';
import { Compare } from './pages/Compare';
import { Ops } from './pages/Ops';
import { RunDetail } from './pages/RunDetail';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Shell() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Login />;
  return (
    <LiveProvider>
      <SettingsProvider>
        <BrowserRouter>
          <a href="#main-content" className="sr-only focus:not-sr-only">Skip to main content</a>
          <Nav />
          <main id="main-content" className="mx-auto max-w-1600 px-24 py-24">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/catalog/:id" element={<ModelDetail />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/compare" element={<Compare />} />
              <Route path="/ops" element={<Ops />} />
              <Route path="/runs/:runId" element={<RunDetail />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </BrowserRouter>
      </SettingsProvider>
    </LiveProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </QueryClientProvider>
  );
}
