import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { LiveProvider } from './hooks/useLive';
import { SettingsProvider } from './providers/SettingsProvider';
import { ToastProvider } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Nav } from './components/Nav';
import { ScrollToTop } from './components/ScrollToTop';
import { useCommandPalette, CommandPalette } from './components/CommandPalette';
import { PageShell } from './components/ui/PageShell';

const Home = lazy(() => import('./pages/Home').then(m => ({ default: m.Home })));
const Catalog = lazy(() => import('./pages/Catalog').then(m => ({ default: m.Catalog })));
const ModelDetail = lazy(() => import('./pages/ModelDetail').then(m => ({ default: m.ModelDetail })));
const Leaderboard = lazy(() => import('./pages/Leaderboard').then(m => ({ default: m.Leaderboard })));
const Compare = lazy(() => import('./pages/Compare').then(m => ({ default: m.Compare })));
const Ops = lazy(() => import('./pages/Ops').then(m => ({ default: m.Ops })));
const Observability = lazy(() => import('./pages/Observability').then(m => ({ default: m.Observability })));
const RunDetail = lazy(() => import('./pages/RunDetail').then(m => ({ default: m.RunDetail })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Runners = lazy(() => import('./pages/Runners').then(m => ({ default: m.Runners })));
const Prompts = lazy(() => import('./pages/Prompts').then(m => ({ default: m.Prompts })));
const Queues = lazy(() => import('./pages/Queues').then(m => ({ default: m.Queues })));
const OutputMappings = lazy(() => import('./pages/OutputMappings').then(m => ({ default: m.OutputMappings })));
const Scenarios = lazy(() => import('./pages/Scenarios').then(m => ({ default: m.Scenarios })));
const Anomalies = lazy(() => import('./pages/Anomalies').then(m => ({ default: m.Anomalies })));
const Comparisons = lazy(() => import('./pages/Comparisons').then(m => ({ default: m.Comparisons })));
const CostLeaderboard = lazy(() => import('./pages/CostLeaderboard').then(m => ({ default: m.CostLeaderboard })));
const Budget = lazy(() => import('./pages/Budget').then(m => ({ default: m.Budget })));
const Schedules = lazy(() => import('./pages/Schedules').then(m => ({ default: m.Schedules })));
const Regression = lazy(() => import('./pages/Regression').then(m => ({ default: m.Regression })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const SessionDetail = lazy(() => import('./pages/SessionDetail').then(m => ({ default: m.SessionDetail })));
const Files = lazy(() => import('./pages/Files').then(m => ({ default: m.Files })));
const Audit = lazy(() => import('./pages/Audit').then(m => ({ default: m.Audit })));
const NotFound = lazy(() => import('./pages/NotFound').then(m => ({ default: m.NotFound })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Shell() {
  const { isAuthenticated } = useAuth();

  return (
    <BrowserRouter>
      {!isAuthenticated ? (
        <Suspense>
          <Login />
        </Suspense>
      ) : (
        <ShellContent />
      )}
    </BrowserRouter>
  );
}

// useCommandPalette() calls useNavigate(), which requires Router context —
// it must live under <BrowserRouter>, not in Shell's own render.
function ShellContent() {
  const palette = useCommandPalette();

  return (
    <LiveProvider>
      <SettingsProvider>
        <ToastProvider>
          <ScrollToTop />
          <a href="#main-content" className="sr-only focus:not-sr-only">
            Skip to main content
          </a>
          <Nav />
          <Suspense fallback={<PageShell title="" loading />}>
            <main
              id="main-content"
              tabIndex={-1}
              className="mx-auto max-w-1600 px-3 md:px-6 py-4 md:py-6 animate-fade-in"
            >
              <ErrorBoundary>
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
                  <Route path="/scenarios" element={<Scenarios />} />
                  <Route path="/anomalies" element={<Anomalies />} />
                  <Route path="/comparisons" element={<Comparisons />} />
                  <Route path="/costs" element={<CostLeaderboard />} />
                  <Route path="/budget" element={<Budget />} />
                  <Route path="/schedules" element={<Schedules />} />
                  <Route path="/regression" element={<Regression />} />
                  <Route path="/sessions" element={<Sessions />} />
                  <Route path="/sessions/:sessionId" element={<SessionDetail />} />
                  <Route path="/files" element={<Files />} />
                  <Route path="/audit" element={<Audit />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </ErrorBoundary>
            </main>
          </Suspense>
          <CommandPalette
            open={palette.open}
            onClose={() => palette.setOpen(false)}
            query={palette.query}
            onQueryChange={palette.setQuery}
            filtered={palette.filtered}
            selectedIndex={palette.selectedIndex}
            selected={palette.selected}
            inputRef={palette.inputRef}
            onKeyDown={palette.handleKeyDown}
            onSelect={palette.execute}
          />
        </ToastProvider>
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
