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
import { Observability } from './pages/Observability';
import { RunDetail } from './pages/RunDetail';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { Runners } from './pages/Runners';
import { Prompts } from './pages/Prompts';
import { Queues } from './pages/Queues';
import { OutputMappings } from './pages/OutputMappings';

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
          <main id="main-content" className="mx-auto max-w-1600 px-6 py-6">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/catalog/:id" element={<ModelDetail />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/compare" element={<Compare />} />
              <Route path="/ops" element={<Ops />} />
              <Route path="/observability" element={<Observability />} />
              <Route path="/runs/:runId" element={<RunDetail />} />
              <Route path="/runners" element={<Runners />} />
              <Route path="/prompts" element={<Prompts />} />
              <Route path="/queues" element={<Queues />} />
              <Route path="/output-mappings" element={<OutputMappings />} />
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
