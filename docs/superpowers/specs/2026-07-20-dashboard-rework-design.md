# Dashboard Rework + Expansion Design

**Date:** 2026-07-20
**Status:** Approved (brainstorming output)
**Depends on:** `2026-07-20-core-rebuild-design.md` (catalog + metrics API must exist)

## Goal

Full visual redesign + functional expansion of ai-model-arena's React dashboard. Replace the current Recharts-only 9-page SPA with a dense, dark, monospace-forward ops console aesthetic — single acid-green accent on near-black background. Add 8 pages (Home, Catalog, Model detail, Leaderboard, Compare, Ops console, Run detail expanded, Settings consolidated). Use ECharts for all charts. Add a signature token-flow Sankey on the home page. All catalog/benchmark/pricing/runtime-metrics data comes from the core-rebuild SQLite DB via the new REST endpoints.

## Non-goals

- Backend changes (covered by core-rebuild spec).
- New WebSocket events (existing LiveHub kept as-is).
- Mobile-first design (target desktop >= 1280px; responsive down to 768px acceptable but not the focus).
- Internationalization.
- Public marketing site.

## Aesthetic direction

Ops console / observability tool. Dark, dense, monospace-forward. Single acid-green accent on near-black background. Feels like a benchmark harness dashboard (Datadog/Grafana-adjacent).

## Design system (DESIGN.md — to be written at `src/dashboard-client/DESIGN.md`)

### Color palette

| Token | Hex | Role |
|---|---|---|
| `--bg-0` | `#0A0E0C` | Page background (near-black, slight green tint) |
| `--bg-1` | `#11161300` | Raised surface (panel) |
| `--bg-2` | `#1A211D` | Input/table row hover |
| `--border` | `#243029` | Hairline divider |
| `--fg-0` | `#E8F0EA` | Primary text |
| `--fg-1` | `#9BB0A2` | Secondary text (labels, captions) |
| `--accent` | `#7CFFA0` | Acid green — live data, primary CTA, signature element |
| `--warn` | `#FFB454` | Amber — degraded / p95 latency |
| `--danger` | `#FF5C5C` | Red — failed runs, anomalies |
| `--info` | `#5CA8FF` | Blue — info badges, links |

Light mode (optional, toggled): invert bg/fg, keep accent/warn/danger same. Test contrast separately.

### Typography

Three roles:
- **Display:** `"JetBrains Mono", monospace` — headings, big numbers, all data values. `font-variant-numeric: tabular-nums`.
- **Body:** `"Inter Tight", system-ui` — paragraphs, descriptions, form labels.
- **Mono:** `"JetBrains Mono"` — code, logs, IDs, table cells with data.

Type scale: 12 / 14 / 16 / 20 / 28 / 44 / 72px. Display weights 500-700, body 400/500.

Font smoothing on root: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`.

### Layout

- Sticky top nav bar (64px): logo + nav links (Home, Catalog, Leaderboard, Compare, Ops, Settings) + cache state pill + theme toggle + user menu.
- Content: 12-col grid, max-width 1600px, 24px gutter, 24px page padding.
- Panels compose all pages: `bg-1`, `border-radius: 8px`, 1px hairline `border` color, 16px padding.
- Concentric radius: panel 8px, inner elements 4px.

### Motion

Frequency-based:
- High-frequency (nav, tab switch): none, instant.
- Hover: 80ms.
- Panel enter: 150ms ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`).
- Sankey re-render: 400ms with staggered node transitions.
- `prefers-reduced-motion: reduce` → all durations to 0.01ms.

### Signature element

Token-flow Sankey on Home. `prompt` → `cache_read | cache_write | completion` → `cost_usd`. Live updates per finalized run. ECharts Sankey series. Nodes colored: prompt=fg-0, cache_read=accent, cache_write=info, completion=warn, cost=danger.

### Components

shadcn-style with CVA variants, hand-rolled (no shadcn dep — keep current `components/ui.tsx` pattern, extend it):

- `Panel`, `PanelHeader`, `PanelBody` — base surface.
- `StatTile` — big number + label + sparkline.
- `DataTable` — sortable, sticky header, hover row, monospace numbers, sticky filter bar.
- `Badge` — tier (S+/S/A etc), status (alpha/beta/deprecated), provider tag, reasoning flag.
- `MetricBar` — horizontal bar with min/max/value, colored by warn/danger thresholds.
- `Button` — variants: primary (accent), ghost (transparent), danger (red). Scale on press.
- `Sankey` — ECharts wrapper, theme-aware.
- `Sparkline` — ECharts line mini, no axes.
- `Heatmap` — ECharts calendar-style for latency p50 over time.
- `LineChart` — ECharts line for latency/TPS history.
- `StackedBar` — ECharts bar for token usage breakdown.
- `Tabs` — keyboard-accessible, `role="tablist"`.

## Pages + routes

```
/                  Home (mission control)
/catalog           Catalog browser (read-only)
/catalog/:id       Model detail
/leaderboard       Combined leaderboard
/compare           Side-by-side comparison (2-4 models)
/ops               Ops console
/runs/:runId       Run detail (expanded)
/settings          Settings (consolidated)
/login             Login (unchanged)
```

Deleted routes: `/launch`, `/scenarios`, `/models`, `/comparisons`, `/analytics`, `/cost`, `/anomalies`. Content folds into new pages (see per-page sections).

### Home (mission control)

Top row: 3 `StatTile`s — Active runs, Models in DB, Cache status (3 sources). Plus primary `[+ Run]` button (opens launcher modal).

Signature: full-width Token Flow Sankey panel.

Below: 2-col grid — left `Top TPS` (3 horizontal MetricBars), right `Recent Runs` (5 rows, status icon + scenario + model + duration + cost).

Bottom: full-width `Anomalies` strip (latest 3, severity badge, resolve button).

Launcher modal: scenario dropdown (from `GET /api/scenarios`), model multi-select (from catalog filtered to `tool_call=1`), max turns override. Submit → `POST /api/runs`. On success, navigate to `/runs/:runId`.

### Catalog browser (`/catalog`)

Full-width `DataTable`. Sticky header + sticky filter bar. Columns: name, provider (Badge), context (mono), reasoning (icon), tool_call (icon), input $, output $, SWE-bench, Coding, Agentic, Speed TPS, status (Badge). Sortable by any column. Filters: provider select, reasoning toggle, tool_call toggle, min_context number, text search. Row click → `/catalog/:id`.

URL deep-linking for filter state (mirrors free-coding-models pattern): `?provider=openai&reasoning=1&sort=context&q=claude`.

### Model detail (`/catalog/:id`)

Header: name (display), provider Badge, status Badge, family, release date, context limit, output limit. Tab bar:
- **Overview** — capabilities grid (attachment, reasoning, temperature, tool_call, interleaved, modalities), pricing table (input/output/cache_read/cache_write, tiers, over-200k), hosting providers list (from `model_providers`).
- **Benchmarks** — grouped by benchmark name. For each: rows for all sources (modelbench/zeroeval), `is_preferred` flagged. Bar chart comparing this model to top-5 peers on the same benchmark.
- **Arena metrics** — from `model_runtime_stats`: latency p50/p95 `LineChart` over time, TPS `LineChart`, cache hit rate `Sparkline`/area, cost per run `StackedBar`. Empty state: "No arena runs yet — trigger a run from Home."
- **Runs** — recent runs table (runId, scenario, success, duration, cost, timestamp). Row click → `/runs/:runId`.

### Leaderboard (`/leaderboard`)

One row per model. Columns: rank, name, provider, Intelligence (preferred), Coding, Agentic, SWE-bench, avg TPS (arena), avg p50 latency (arena), avg cache hit (arena), cost per success (arena). Sort by any column. Filters: provider, tier, has-arena-data toggle. Export CSV button. Source: `GET /api/cache/leaderboard` (combined catalog + arena).

### Compare (`/compare`)

Model multi-select (2-4). Side-by-side columns: caps grid, pricing, benchmark bars (overlaid, color per model), arena metrics. Visual diff bars where a metric exceeds the group min/max. Empty state: "Pick 2-4 models to compare."

### Ops console (`/ops`)

- **PM2 process table** — live, WS-fed (`process_status`). Columns: name, status, cpu, mem, uptime, run/model/scenario. Auto-refresh from WS.
- **Cache state** — 3 source cards (models.dev/modelbench/zeroeval): last_fetch, next_refresh, count, status Badge. Force-refresh button each → `POST /api/cache/refresh`.
- **Anomaly feed** — latest 10 anomalies with severity, resolve button. Folded from old `/anomalies`.
- **Tool analytics** — tool-call success/failure bars, loop incidents count. Folded from old `/analytics`.
- **Provider config** — table of providers (builtin + custom). Add/edit custom via modal. (Mirror of Settings providers tab.)

### Run detail (`/runs/:runId`) — expanded

Header: scenario, startedAt, finishedAt, duration, status Badge, cost. Model selector (existing). Tab bar:
- **Conversation** — existing `ConversationView`, restyled.
- **Files** — existing CodeMirror.
- **Logs** — existing PM2 log tail.
- **Trace** — existing `TraceWaterfall`, restyled.
- **Metrics** (NEW) — per-turn latency `LineChart` (ECharts), token usage `StackedBar` (prompt/completion/cache_read/cache_write), cost accumulation `LineChart`. Pulls from `trace-meta.json` + `result.json`. WS-driven: invalidates on `run_completed`.

### Settings (`/settings`) — consolidated

Tabs:
- **General** — theme toggle (auto/dark/light), default max turns, default temperature.
- **Auth** — JWT password change, API key management (scopes), current JWT token view.
- **Scenarios** — existing `ScenarioForm` CRUD. Folded from `/scenarios`.
- **Providers** — custom provider CRUD (add OpenAI-compatible endpoint). Mirror of Ops providers table.
- **Notifications** — existing webhooks CRUD.

## Data flow + state

**State management:** TanStack Query for all REST data. Existing `AuthProvider` + `LiveProvider` kept. New `SettingsProvider` for theme + user prefs (localStorage-persisted, server-synced).

**Query keys + refetch intervals:**

| Query key | Endpoint | Refetch |
|---|---|---|
| `['catalog', 'models', filters]` | `GET /api/models?...` | 60s |
| `['catalog', 'model', id]` | `GET /api/models/:id` | 30s |
| `['catalog', 'benchmarks', filters]` | `GET /api/benchmarks?...` | 5m |
| `['catalog', 'pricing']` | `GET /api/pricing` | 5m |
| `['metrics', 'runtime', filters]` | `GET /api/metrics/runtime?...` | 10s |
| `['metrics', 'tps']` | `GET /api/metrics/tps` | 10s |
| `['cache', 'stats']` | `GET /api/cache/stats` | 30s |
| `['cache', 'leaderboard']` | `GET /api/cache/leaderboard` | 15s |
| `['cache', 'sankey']` | aggregated client-side from `['metrics', 'runtime']` | 10s |

**WebSocket (LiveHub, existing):** Unchanged for `process_status`, `conversation_snapshot`, `conversation_update`, `log_line`, `run_completed`. On `run_completed`, invalidate `['metrics', 'runtime']`, `['metrics', 'tps']`, `['cache', 'leaderboard']`, `['cache', 'sankey']`, `['runs']`.

**Launcher flow:** Home `[+ Run]` → modal → submit `POST /api/runs` → navigate to `/runs/:runId`.

**Theme:** Tri-state auto/dark/light. `prefers-color-scheme` for auto. Persisted to localStorage + synced to `document.documentElement.dataset.theme`. Defaults to dark (ops console aesthetic).

## Charting library

Replace Recharts with ECharts (`echarts` + `echarts-for-react` wrappers). All chart components (`Sankey`, `Sparkline`, `Heatmap`, `LineChart`, `StackedBar`) wrap ECharts with theme-aware options derived from DESIGN.md tokens. Remove Recharts dependency.

## Error handling

- API failure (non-2xx): TanStack Query `error` state → panel shows inline error with retry button. No global toast for read failures.
- WS disconnect: existing `LiveProvider` shows connection-status pill in nav bar.
- Empty state: each panel has a typed empty state ("No arena runs yet — trigger a run from Home." / "No benchmarks for this model." / "Pick 2-4 models to compare.").
- Stale data: `cache stats` pill in nav shows "stale" Badge (red) when any source `last_status === 'error'`.

## Accessibility

- Semantic HTML before ARIA (`<button>`, `<nav>`, `<main>`, `<table>`).
- Keyboard nav: Tab/Shift+Tab, Enter/Space, Arrow keys for tabs/tables, Escape closes modals.
- Visible `:focus-visible` rings (accent color, 2px, offset 2px).
- Contrast: WCAG AA 4.5:1 verified for all token pairs (accent on bg-0, fg-1 on bg-0, etc.).
- `prefers-reduced-motion: reduce` respected.
- Skip link to `#main-content`.

## Testing

- **Component unit tests** (Vitest + Testing Library, new devDeps): each new component renders correctly with mock data, responds to props, handles loading/error/empty states.
- **ECharts wrapper tests**: assert ECharts `setOption` called with expected config given props.
- **Page integration tests**: mock TanStack Query + WS, assert page renders expected panels.
- **Visual snapshot**: optional Playwright screenshot of each page (skip if env lacks browser).
- **A11y**: axe-core check in Vitest for each page.

## Build approach

1. Write `DESIGN.md` at `src/dashboard-client/DESIGN.md` (tokens, type scale, color palette, component specs, motion rules).
2. Install ECharts deps, remove Recharts.
3. Build shared components (`Panel`, `StatTile`, `DataTable`, `Badge`, `MetricBar`, `Button`, chart wrappers).
4. Build pages one by one against DESIGN.md + shared components.
5. Wire routes + nav.
6. Delete old pages/components.
7. Smoke test.

## Out of scope

- Core rebuild (separate spec).
- Backend API changes (covered by core-rebuild).
- New WebSocket events.
- Public marketing site.
- Mobile-first design.

## References

- Core rebuild spec: `docs/superpowers/specs/2026-07-20-core-rebuild-design.md`
- ECharts: https://echarts.apache.org/
- shadcn CVA pattern (for variant styling approach, not the dep)
- free-coding-models dashboard reference: https://github.com/vava-nessa/free-coding-models
