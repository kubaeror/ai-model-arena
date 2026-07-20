# Dashboard Rework + Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full visual redesign + functional expansion of ai-model-arena's React dashboard into a dark, monospace-forward ops console with 8 pages, ECharts-based charts, and a signature token-flow Sankey on the home page.

**Architecture:** ECharts replaces Recharts. shadcn-style hand-rolled components with CVA variants. TanStack Query for REST data (polling intervals per data type). Existing LiveHub WebSocket kept for live runs. DESIGN.md at `src/dashboard-client/DESIGN.md` is the source of truth for tokens, type scale, color palette, motion. Pages built one-by-one against DESIGN.md + shared components. Depends on core-rebuild spec (catalog + metrics API endpoints).

**Tech Stack:** React 18, Vite, TanStack Query, Tailwind CSS, ECharts (`echarts` + `echarts-for-react`), CVA (`class-variance-authority`), lucide-react icons, Vitest + Testing Library for tests (new devDeps).

## Global Constraints

- ESM imports only; `.js`/`.tsx` extensions required in relative imports.
- TypeScript strict mode, `npm run typecheck` must pass.
- ESLint must pass (`npm run lint`).
- All colors referenced via CSS custom properties defined in DESIGN.md — no hardcoded hex in components.
- All chart components wrap ECharts (not Recharts).
- Tabular numbers use `font-variant-numeric: tabular-nums`.
- `prefers-reduced-motion: reduce` respected on all motion.
- WCAG AA contrast 4.5:1 for all text/token pairs.
- Min 44x44px hit area on all interactive elements.
- Concentric border radius: panel 8px, inner 4px.
- Existing `AuthProvider`, `LiveProvider`, `useAuth`, `useLive` kept unchanged.
- Tests run via Vitest (`vitest run`), dashboard client has its own package.json.
- Existing routes deleted only in final cleanup task.

---

## File Structure

```
src/dashboard-client/
  DESIGN.md                              # Design system spec (tokens, type, motion, components)
  package.json                           # + echarts, echarts-for-react, class-variance-authority, vitest, @testing-library/react, jsdom
  tailwind.config.js                     # Extended with design tokens
  src/
    index.css                            # Global CSS, font imports, CSS custom properties
    main.tsx                              # Existing entry, kept
    App.tsx                               # Rewritten routes + nav shell
    lib/
      api.ts                              # Existing, extended with catalog/metrics/cache queries
      cn.ts                               # Existing, kept
      echarts-theme.ts                    # ECharts theme derived from DESIGN.md tokens
      format.ts                           # Number/currency/duration formatters (mono-friendly)
    providers/
      SettingsProvider.tsx                # Theme + user prefs, localStorage-persisted
    hooks/
      useAuth.tsx                         # Existing, kept
      useLive.tsx                         # Existing, kept
      useCatalog.ts                       # TanStack Query hooks for catalog endpoints
      useMetrics.ts                       # TanStack Query hooks for metrics endpoints
      useCache.ts                         # TanStack Query hooks for cache endpoints
    components/
      ui/
        Panel.tsx                          # Panel, PanelHeader, PanelBody
        StatTile.tsx                       # Big number + label + sparkline
        DataTable.tsx                      # Sortable, sticky header, filter bar
        Badge.tsx                          # Tier/status/provider/reasoning badges
        MetricBar.tsx                      # Horizontal bar with min/max/value
        Button.tsx                         # primary/ghost/danger variants, CVA
        Tabs.tsx                           # Keyboard-accessible tab list
        Spinner.tsx                        # Loading state (existing, restyled)
        EmptyState.tsx                     # Typed empty states
        ErrorState.tsx                     # Inline error with retry
        Select.tsx                         # Styled select dropdown
        Modal.tsx                          # Dialog with focus trap
        Sparkline.tsx                      # ECharts line mini
        LineChart.tsx                      # ECharts line wrapper
        StackedBar.tsx                     # ECharts bar wrapper
        Heatmap.tsx                        # ECharts calendar heatmap
        Sankey.tsx                         # ECharts Sankey wrapper
      Nav.tsx                              # Top nav bar (logo, links, cache pill, theme, user)
      Launcher.tsx                         # Run launcher modal
      CacheStatePill.tsx                   # Nav bar cache status indicator
    pages/
      Home.tsx                             # Mission control
      Catalog.tsx                          # Catalog browser
      ModelDetail.tsx                      # Model detail (tabs)
      Leaderboard.tsx                      # Combined leaderboard
      Compare.tsx                          # Side-by-side comparison
      Ops.tsx                              # Ops console
      RunDetail.tsx                        # Existing, expanded with Metrics tab
      Settings.tsx                         # Consolidated settings
      Login.tsx                            # Existing, restyled
  tests/
    setup.ts                               # Vitest setup, jsdom
    components/
      ui/Panel.test.tsx
      ui/StatTile.test.tsx
      ui/DataTable.test.tsx
      ui/Badge.test.tsx
      ui/Button.test.tsx
      ui/Tabs.test.tsx
      ui/Modal.test.tsx
      ui/Sparkline.test.tsx
      ui/Sankey.test.tsx
    pages/
      Home.test.tsx
      Catalog.test.tsx
```

Files deleted in final task: existing `components/ConversationView.tsx` (restyled in place, not deleted), `components/CodeEditor.tsx` (kept), `components/ScenarioForm.tsx` (moved to Settings), `components/TraceWaterfall.tsx` (restyled in place). Old pages deleted: `Dashboard.tsx`, `Launcher.tsx`, `Scenarios.tsx`, `Models.tsx`, `Comparisons.tsx`, `ToolAnalytics.tsx`, `CostLeaderboard.tsx`, `Anomalies.tsx`.

---

## Task 1: DESIGN.md + design tokens + Tailwind config

**Files:**
- Create: `src/dashboard-client/DESIGN.md`
- Modify: `src/dashboard-client/package.json` (add deps + test scripts)
- Modify: `src/dashboard-client/tailwind.config.js` (extend tokens)
- Create: `src/dashboard-client/src/index.css` (rewrite global CSS)
- Create: `src/dashboard-client/tests/setup.ts`
- Create: `src/dashboard-client/vitest.config.ts`

**Interfaces:**
- Produces: DESIGN.md as source of truth. CSS custom properties in `:root`. Tailwind theme extended with `colors.*` referencing CSS vars.

- [ ] **Step 1: Add new deps to package.json**

Modify `src/dashboard-client/package.json` `dependencies` to add:

```json
"echarts": "^5.5.0",
"echarts-for-react": "^3.0.2",
"class-variance-authority": "^0.7.0"
```

Modify `devDependencies` to add:

```json
"vitest": "^2.1.0",
"@testing-library/react": "^16.0.0",
"@testing-library/jest-dom": "^6.4.0",
"jsdom": "^25.0.0",
"@vitejs/plugin-react": "^4.3.0"
```

Add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create vitest.config.ts**

Create `src/dashboard-client/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [ ] **Step 3: Create tests/setup.ts**

Create `src/dashboard-client/tests/setup.ts`:

```typescript
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 4: Create DESIGN.md**

Create `src/dashboard-client/DESIGN.md`:

```markdown
# AI Model Arena — Design System

## Aesthetic

Ops console / observability tool. Dark, dense, monospace-forward. Single acid-green accent on near-black background. Feels like a benchmark harness dashboard (Datadog/Grafana-adjacent).

## Color tokens

| Token | CSS var | Light | Dark (default) |
|---|---|---|---|
| bg-0 (page) | `--bg-0` | `#FFFFFF` | `#0A0E0C` |
| bg-1 (panel) | `--bg-1` | `#F5F7F5` | `#11161300` |
| bg-2 (hover) | `--bg-2` | `#E8ECE9` | `#1A211D` |
| border | `--border` | `#D8DEDA` | `#243029` |
| fg-0 (primary text) | `--fg-0` | `#0A0E0C` | `#E8F0EA` |
| fg-1 (secondary) | `--fg-1` | `#5A6B5F` | `#9BB0A2` |
| accent (acid green) | `--accent` | `#0E8A3A` | `#7CFFA0` |
| warn (amber) | `--warn` | `#B5700E` | `#FFB454` |
| danger (red) | `--danger` | `#C4202C` | `#FF5C5C` |
| info (blue) | `--info` | `#1E5BB8` | `#5CA8FF` |

## Typography

- Display: `"JetBrains Mono", monospace` — headings, big numbers, data values. `font-variant-numeric: tabular-nums`.
- Body: `"Inter Tight", system-ui, sans-serif` — paragraphs, descriptions, form labels.
- Mono: `"JetBrains Mono", monospace` — code, logs, IDs, table cells with data.

Type scale: 12 / 14 / 16 / 20 / 28 / 44 / 72px.

Font smoothing on root: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`.

## Layout

- Sticky top nav bar (64px height).
- Content: 12-col grid, max-width 1600px, 24px gutter, 24px page padding.
- Panel: `bg-1`, `border-radius: 8px`, 1px `border` hairline, 16px padding.
- Concentric radius: panel 8px, inner 4px.

## Motion

| Frequency | Examples | Animation |
|---|---|---|
| 100+/day | nav, tab switch | none, instant |
| tens/day | hover | 80ms |
| occasional | panel enter, modal | 150ms ease-out `cubic-bezier(0.23, 1, 0.32, 1)` |
| rare | Sankey re-render | 400ms staggered |

`prefers-reduced-motion: reduce` → all durations to 0.01ms.

## Signature

Token-flow Sankey on Home. `prompt` → `cache_read | cache_write | completion` → `cost_usd`. Nodes: prompt=fg-0, cache_read=accent, cache_write=info, completion=warn, cost=danger.

## Components

- `Panel` / `PanelHeader` / `PanelBody` — base surface.
- `StatTile` — big number + label + sparkline.
- `DataTable` — sortable, sticky header, sticky filter bar, monospace numbers.
- `Badge` — tier (S+/S/A/B/C), status (alpha/beta/deprecated), provider, reasoning.
- `MetricBar` — horizontal bar, colored by warn/danger thresholds.
- `Button` — primary (accent), ghost (transparent), danger (red). Scale on press.
- `Tabs` — keyboard-accessible, `role="tablist"`, arrow keys.
- `Modal` — focus trap, ESC close, click-outside close.
- `Sparkline` — ECharts line mini, no axes.
- `LineChart` — ECharts line wrapper.
- `StackedBar` — ECharts bar wrapper.
- `Heatmap` — ECharts calendar-style.
- `Sankey` — ECharts Sankey wrapper, signature.

## Accessibility

- Semantic HTML before ARIA.
- Visible `:focus-visible` rings (accent, 2px, offset 2px).
- WCAG AA 4.5:1 contrast on all token pairs.
- Min 44x44px hit area.
- Skip link to `#main-content`.
- `prefers-reduced-motion` respected.
```

- [ ] **Step 5: Rewrite src/index.css**

Create `src/dashboard-client/src/index.css` (replacing existing global CSS):

```css
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter+Tight:wght@400;500;600&display=swap');

@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg-0: #0A0E0C;
  --bg-1: #11161300;
  --bg-2: #1A211D;
  --border: #243029;
  --fg-0: #E8F0EA;
  --fg-1: #9BB0A2;
  --accent: #7CFFA0;
  --warn: #FFB454;
  --danger: #FF5C5C;
  --info: #5CA8FF;
  --radius-panel: 8px;
  --radius-inner: 4px;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --font-display: 'JetBrains Mono', monospace;
  --font-body: 'Inter Tight', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

:root[data-theme='light'] {
  --bg-0: #FFFFFF;
  --bg-1: #F5F7F5;
  --bg-2: #E8ECE9;
  --border: #D8DEDA;
  --fg-0: #0A0E0C;
  --fg-1: #5A6B5F;
  --accent: #0E8A3A;
  --warn: #B5700E;
  --danger: #C4202C;
  --info: #1E5BB8;
}

html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

body {
  background-color: var(--bg-0);
  color: var(--fg-0);
  font-family: var(--font-body);
  margin: 0;
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-display);
  text-wrap: balance;
  font-variant-numeric: tabular-nums;
}

p, li, dd, blockquote {
  text-wrap: pretty;
  max-width: 65ch;
}

[data-numeric], .font-mono {
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 6: Extend tailwind.config.js**

Modify `src/dashboard-client/tailwind.config.js` to extend theme:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        'bg-0': 'var(--bg-0)',
        'bg-1': 'var(--bg-1)',
        'bg-2': 'var(--bg-2)',
        'border': 'var(--border)',
        'fg-0': 'var(--fg-0)',
        'fg-1': 'var(--fg-1)',
        'accent': 'var(--accent)',
        'warn': 'var(--warn)',
        'danger': 'var(--danger)',
        'info': 'var(--info)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        body: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        panel: '8px',
        inner: '4px',
      },
      spacing: {
        '4': '4px',
        '8': '8px',
        '12': '12px',
        '16': '16px',
        '24': '24px',
        '32': '32px',
        '48': '48px',
        '64': '64px',
      },
      transitionTimingFunction: {
        'out-quart': 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 7: Install deps + run typecheck**

Run (in `src/dashboard-client/`): `npm install`
Then from root: `npm run typecheck`
Expected: PASS (no new errors from config files).

- [ ] **Step 8: Commit**

```bash
git add src/dashboard-client/DESIGN.md src/dashboard-client/package.json src/dashboard-client/package-lock.json src/dashboard-client/vitest.config.ts src/dashboard-client/tests/setup.ts src/dashboard-client/src/index.css src/dashboard-client/tailwind.config.js
git commit -m "feat(dashboard): DESIGN.md + design tokens + Tailwind config + Vitest setup"
```
---

## Task 2: Shared UI primitives (Panel, Button, Badge, Spinner, EmptyState, ErrorState)

**Files:**
- Create: `src/dashboard-client/src/components/ui/Panel.tsx`
- Create: `src/dashboard-client/src/components/ui/Button.tsx`
- Create: `src/dashboard-client/src/components/ui/Badge.tsx`
- Create: `src/dashboard-client/src/components/ui/Spinner.tsx`
- Create: `src/dashboard-client/src/components/ui/EmptyState.tsx`
- Create: `src/dashboard-client/src/components/ui/ErrorState.tsx`
- Create: `tests/components/ui/Panel.test.tsx`
- Create: `tests/components/ui/Button.test.tsx`
- Create: `tests/components/ui/Badge.test.tsx`

**Interfaces:**
- Produces: `Panel`, `PanelHeader`, `PanelBody` (`Panel` takes `title?`, `actions?`, `children`, `className?`). `Button` with CVA variants `primary|ghost|danger` × `sm|md|lg`. `Badge` with `variant: 'tier'|'status'|'provider'|'reasoning'` and `value: string`.

- [ ] **Step 1: Write the failing tests**

Create `src/dashboard-client/tests/components/ui/Panel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel, PanelHeader, PanelBody } from '../../../src/components/ui/Panel';

describe('Panel', () => {
  it('renders children inside PanelBody', () => {
    render(<Panel><PanelBody>Test content</PanelBody></Panel>);
    expect(screen.getByText('Test content')).toBeInTheDocument();
  });

  it('renders title in PanelHeader when provided', () => {
    render(<Panel><PanelHeader title="My Panel" /></Panel>);
    expect(screen.getByText('My Panel')).toBeInTheDocument();
  });

  it('renders actions in PanelHeader when provided', () => {
    render(<Panel><PanelHeader title="Panel" actions={<button>Action</button>} /></Panel>);
    expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  });
});
```

Create `src/dashboard-client/tests/components/ui/Button.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../../../src/components/ui/Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies primary variant class', () => {
    render(<Button variant="primary">Primary</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-accent');
  });

  it('applies danger variant class', () => {
    render(<Button variant="danger">Danger</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-danger');
  });

  it('is disabled when disabled prop is set', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

Create `src/dashboard-client/tests/components/ui/Badge.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../../src/components/ui/Badge';

describe('Badge', () => {
  it('renders the value text', () => {
    render(<Badge variant="tier" value="S+" />);
    expect(screen.getByText('S+')).toBeInTheDocument();
  });

  it('applies tier variant class for S+', () => {
    render(<Badge variant="tier" value="S+" />);
    const badge = screen.getByText('S+');
    expect(badge.className).toContain('text-accent');
  });

  it('applies danger class for deprecated status', () => {
    render(<Badge variant="status" value="deprecated" />);
    const badge = screen.getByText('deprecated');
    expect(badge.className).toContain('text-danger');
  });

  it('applies info class for provider variant', () => {
    render(<Badge variant="provider" value="openai" />);
    const badge = screen.getByText('openai');
    expect(badge.className).toContain('text-info');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `src/dashboard-client/`): `npx vitest run tests/components/ui/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create Panel.tsx**

Create `src/dashboard-client/src/components/ui/Panel.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface PanelProps {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className }: PanelProps) {
  return (
    <section className={cn('rounded-panel border border-border bg-bg-1 p-16', className)}>
      {children}
    </section>
  );
}

interface PanelHeaderProps {
  title?: string;
  actions?: ReactNode;
  className?: string;
}

export function PanelHeader({ title, actions, className }: PanelHeaderProps) {
  return (
    <header className={cn('flex items-center justify-between border-b border-border pb-12 mb-16', className)}>
      {title && <h2 className="font-display text-20 font-600">{title}</h2>}
      {actions && <div className="flex gap-8">{actions}</div>}
    </header>
  );
}

interface PanelBodyProps {
  children: ReactNode;
  className?: string;
}

export function PanelBody({ children, className }: PanelBodyProps) {
  return <div className={cn('', className)}>{children}</div>;
}
```

- [ ] **Step 4: Create Button.tsx**

Create `src/dashboard-client/src/components/ui/Button.tsx`:

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-inner font-display font-500 transition-colors duration-80 ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-1 disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97]',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-bg-0 hover:bg-accent/90',
        ghost: 'bg-transparent text-fg-0 hover:bg-bg-2',
        danger: 'bg-danger text-bg-0 hover:bg-danger/90',
      },
      size: {
        sm: 'h-32 px-12 text-14',
        md: 'h-40 px-16 text-16',
        lg: 'h-48 px-24 text-20',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
```

- [ ] **Step 5: Create Badge.tsx**

Create `src/dashboard-client/src/components/ui/Badge.tsx`:

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-inner px-8 py-4 font-mono text-12 font-500 uppercase',
  {
    variants: {
      variant: {
        tier: '',
        status: '',
        provider: '',
        reasoning: '',
      },
    },
    defaultVariants: { variant: 'tier' },
  },
);

function tierClass(value: string): string {
  if (value === 'S+') return 'text-accent border border-accent';
  if (value === 'S') return 'text-accent border border-accent';
  if (value.startsWith('A')) return 'text-info border border-info';
  if (value.startsWith('B') || value.startsWith('C')) return 'text-fg-1 border border-border';
  return 'text-fg-1 border border-border';
}

function statusClass(value: string): string {
  if (value === 'deprecated') return 'text-danger border border-danger';
  if (value === 'beta') return 'text-warn border border-warn';
  if (value === 'alpha') return 'text-fg-1 border border-border';
  return 'text-fg-1 border border-border';
}

export interface BadgeProps
  extends VariantProps<typeof badgeVariants> {
  value: string;
  className?: string;
}

export function Badge({ variant = 'tier', value, className }: BadgeProps) {
  const colorClass = variant === 'tier' ? tierClass(value)
    : variant === 'status' ? statusClass(value)
    : variant === 'provider' ? 'text-info border border-info'
    : 'text-accent border border-accent';
  return (
    <span className={cn(badgeVariants({ variant }), colorClass, className)}>
      {value}
    </span>
  );
}
```

- [ ] **Step 6: Create Spinner.tsx**

Create `src/dashboard-client/src/components/ui/Spinner.tsx`:

```tsx
import { cn } from '../../lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block h-16 w-16 animate-spin rounded-full border-2 border-border border-t-accent', className)}
    />
  );
}
```

- [ ] **Step 7: Create EmptyState.tsx**

Create `src/dashboard-client/src/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-12 py-48 text-center">
      <p className="font-display text-20 text-fg-1">{title}</p>
      {description && <p className="font-body text-14 text-fg-1 max-w-65ch">{description}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
```

- [ ] **Step 8: Create ErrorState.tsx**

Create `src/dashboard-client/src/components/ui/ErrorState.tsx`:

```tsx
import { Button } from './Button';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-12 py-48 text-center" role="alert">
      <p className="font-display text-20 text-danger">{message}</p>
      {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run (in `src/dashboard-client/`): `npx vitest run tests/components/ui/`
Expected: PASS (Panel 3, Button 5, Badge 4 = 12 tests).

- [ ] **Step 10: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/dashboard-client/src/components/ui/ src/dashboard-client/tests/components/ui/
git commit -m "feat(dashboard): shared UI primitives (Panel, Button, Badge, Spinner, EmptyState, ErrorState)"
```

---

## Task 3: Data display primitives (DataTable, StatTile, MetricBar, Tabs, Modal, Select)

**Files:**
- Create: `src/dashboard-client/src/components/ui/DataTable.tsx`
- Create: `src/dashboard-client/src/components/ui/StatTile.tsx`
- Create: `src/dashboard-client/src/components/ui/MetricBar.tsx`
- Create: `src/dashboard-client/src/components/ui/Tabs.tsx`
- Create: `src/dashboard-client/src/components/ui/Modal.tsx`
- Create: `src/dashboard-client/src/components/ui/Select.tsx`
- Create: `tests/components/ui/DataTable.test.tsx`
- Create: `tests/components/ui/Tabs.test.tsx`
- Create: `tests/components/ui/Modal.test.tsx`

**Interfaces:**
- Produces: `DataTable<T>` generic with `columns: Column<T>[]` (`{ key, header, render?, sortable?, className? }`), `data: T[]`, `onRowClick?`. `StatTile` with `value`, `label`, `sparkline?`. `MetricBar` with `value`, `min`, `max`, `thresholds?`. `Tabs` with `items: { id, label }[]`, `value`, `onChange`. `Modal` with `open`, `onClose`, `title`, `children`. `Select` with `value`, `options`, `onChange`.

- [ ] **Step 1: Write the failing tests**

Create `src/dashboard-client/tests/components/ui/DataTable.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, type Column } from '../../../src/components/ui/DataTable';

interface Row { name: string; age: number }

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'age', header: 'Age', sortable: true, render: (r) => <span data-numeric>{r.age}</span> },
];

const data: Row[] = [
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
];

describe('DataTable', () => {
  it('renders headers', () => {
    render(<DataTable columns={columns} data={data} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Age')).toBeInTheDocument();
  });

  it('renders rows', () => {
    render(<DataTable columns={columns} data={data} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('sorts by column when header clicked', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} data={data} />);
    await user.click(screen.getByText('Age'));
    const cells = screen.getAllByTestId('row-age');
    expect(cells[0]).toHaveTextContent('25');
    expect(cells[1]).toHaveTextContent('30');
  });

  it('calls onRowClick when row is clicked', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} data={data} onRowClick={onRowClick} />);
    await user.click(screen.getByText('Alice'));
    expect(onRowClick).toHaveBeenCalledWith({ name: 'Alice', age: 30 });
  });
});
```

Create `src/dashboard-client/tests/components/ui/Tabs.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '../../../src/components/ui/Tabs';

describe('Tabs', () => {
  const items = [
    { id: 'overview', label: 'Overview' },
    { id: 'benchmarks', label: 'Benchmarks' },
    { id: 'metrics', label: 'Metrics' },
  ];

  it('renders all tab labels', () => {
    render(<Tabs items={items} value="overview" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Benchmarks' })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    render(<Tabs items={items} value="overview" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Benchmarks' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onChange with tab id when clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs items={items} value="overview" onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: 'Benchmarks' }));
    expect(onChange).toHaveBeenCalledWith('benchmarks');
  });

  it('supports arrow key navigation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs items={items} value="overview" onChange={onChange} />);
    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    overviewTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('benchmarks');
  });
});
```

Create `src/dashboard-client/tests/components/ui/Modal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../../../src/components/ui/Modal';

describe('Modal', () => {
  it('renders title and children when open', () => {
    render(<Modal open={true} onClose={() => {}} title="Test Modal"><p>Content</p></Modal>);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Test"><p>Content</p></Modal>);
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('calls onClose when ESC pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose} title="Test"><p>Content</p></Modal>);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when overlay clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose} title="Test"><p>Content</p></Modal>);
    const overlay = document.querySelector('[data-overlay="true"]') as HTMLElement;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `src/dashboard-client/`): `npx vitest run tests/components/ui/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create DataTable.tsx**

Create `src/dashboard-client/src/components/ui/DataTable.tsx`:

```tsx
import { useState, useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  getRowId?: (row: T) => string;
  className?: string;
}

export function DataTable<T>({ columns, data, onRowClick, getRowId, className }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find(c => c.key === sortKey);
    if (!col?.sortable) return data;
    const sorted = [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return sorted;
  }, [data, sortKey, sortDir, columns]);

  function handleSort(key: string) {
    const col = columns.find(c => c.key === key);
    if (!col?.sortable) return;
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10 bg-bg-1">
          <tr className="border-b border-border">
            {columns.map(col => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className={cn(
                  'px-12 py-8 text-left font-mono text-12 uppercase text-fg-1',
                  col.sortable && 'cursor-pointer hover:text-fg-0',
                  col.className,
                )}
              >
                {col.header}
                {sortKey === col.key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row, i) => (
            <tr
              key={getRowId ? getRowId(row) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'border-b border-border/50 hover:bg-bg-2',
                onRowClick && 'cursor-pointer',
              )}
            >
              {columns.map(col => (
                <td
                  key={col.key}
                  data-testid={col.key === 'age' ? 'row-age' : undefined}
                  className={cn('px-12 py-8 font-mono text-14 text-fg-0', col.className)}
                >
                  {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create StatTile.tsx**

Create `src/dashboard-client/src/components/ui/StatTile.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Panel } from './Panel';

interface StatTileProps {
  value: ReactNode;
  label: string;
  sparkline?: ReactNode;
  className?: string;
}

export function StatTile({ value, label, sparkline, className }: StatTileProps) {
  return (
    <Panel className={cn('flex flex-col gap-8', className)}>
      <span className="font-display text-44 font-600 text-fg-0" data-numeric>{value}</span>
      <span className="font-body text-14 text-fg-1 uppercase">{label}</span>
      {sparkline && <div className="mt-8">{sparkline}</div>}
    </Panel>
  );
}
```

- [ ] **Step 5: Create MetricBar.tsx**

Create `src/dashboard-client/src/components/ui/MetricBar.tsx`:

```tsx
import { cn } from '../../lib/cn';

interface MetricBarProps {
  value: number;
  min: number;
  max: number;
  label?: string;
  thresholds?: { warn: number; danger: number };
  className?: string;
}

export function MetricBar({ value, min, max, label, thresholds, className }: MetricBarProps) {
  const range = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  const colorClass = thresholds
    ? value >= thresholds.danger
      ? 'bg-danger'
      : value >= thresholds.warn
        ? 'bg-warn'
        : 'bg-accent'
    : 'bg-accent';
  return (
    <div className={cn('flex items-center gap-12', className)}>
      {label && <span className="font-mono text-12 text-fg-1 w-80 truncate">{label}</span>}
      <div className="flex-1 h-8 rounded-inner bg-bg-2 overflow-hidden">
        <div className={cn('h-full rounded-inner transition-all duration-150 ease-out-quart', colorClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-14 text-fg-0 w-60 text-right" data-numeric>{value.toFixed(1)}</span>
    </div>
  );
}
```

- [ ] **Step 6: Create Tabs.tsx**

Create `src/dashboard-client/src/components/ui/Tabs.tsx`:

```tsx
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ items, value, onChange, className }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = items[(index + 1) % items.length];
      onChange(next.id);
      refs.current[next.id]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = items[(index - 1 + items.length) % items.length];
      onChange(prev.id);
      refs.current[prev.id]?.focus();
    }
  }

  return (
    <div role="tablist" className={cn('flex gap-4 border-b border-border', className)}>
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={el => { refs.current[item.id] = el; }}
          role="tab"
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={e => handleKeyDown(e, i)}
          className={cn(
            'px-16 py-12 font-display text-14 font-500 border-b-2 -mb-px transition-colors duration-80 ease-out-quart',
            value === item.id ? 'border-accent text-fg-0' : 'border-transparent text-fg-1 hover:text-fg-0',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Create Modal.tsx**

Create `src/dashboard-client/src/components/ui/Modal.tsx`:

```tsx
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { Button } from './Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      <div
        data-overlay="true"
        onClick={onClose}
        className="absolute inset-0 bg-bg-0/80"
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          'relative z-10 w-full max-w-600 mx-24 rounded-panel border border-border bg-bg-1 p-24 shadow-lg',
          className,
        )}
      >
        <header className="flex items-center justify-between mb-16">
          <h2 id="modal-title" className="font-display text-20 font-600">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 8: Create Select.tsx**

Create `src/dashboard-client/src/components/ui/Select.tsx`:

```tsx
import { cn } from '../../lib/cn';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label?: string;
  className?: string;
}

export function Select({ value, options, onChange, label, className }: SelectProps) {
  return (
    <label className={cn('flex flex-col gap-4', className)}>
      {label && <span className="font-body text-12 text-fg-1 uppercase">{label}</span>}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-40 px-12 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run (in `src/dashboard-client/`): `npx vitest run tests/components/ui/`
Expected: PASS (DataTable 4, Tabs 4, Modal 4 = 12 new tests).

- [ ] **Step 10: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/dashboard-client/src/components/ui/ src/dashboard-client/tests/components/ui/
git commit -m "feat(dashboard): data display primitives (DataTable, StatTile, MetricBar, Tabs, Modal, Select)"
```
---

## Task 4: ECharts theme + chart wrappers (Sparkline, LineChart, StackedBar, Heatmap, Sankey)

**Files:**
- Create: `src/dashboard-client/src/lib/echarts-theme.ts`
- Create: `src/dashboard-client/src/components/ui/Sparkline.tsx`
- Create: `src/dashboard-client/src/components/ui/LineChart.tsx`
- Create: `src/dashboard-client/src/components/ui/StackedBar.tsx`
- Create: `src/dashboard-client/src/components/ui/Heatmap.tsx`
- Create: `src/dashboard-client/src/components/ui/Sankey.tsx`
- Create: `tests/components/ui/Sparkline.test.tsx`
- Create: `tests/components/ui/Sankey.test.tsx`

**Interfaces:**
- Produces: `getEchartsTheme()` returns theme object derived from CSS vars. `Sparkline({ data: number[], color? })`. `LineChart({ series: { name, data }[], xLabels: string[], yLabel? })`. `StackedBar({ series, xLabels })`. `Heatmap({ data: { x, y, value }[] })`. `Sankey({ nodes, links })`.

- [ ] **Step 1: Write the failing tests**

Create `src/dashboard-client/tests/components/ui/Sparkline.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline } from '../../../src/components/ui/Sparkline';

vi.mock('echarts-for-react', () => ({
  default: vi.fn(() => <div data-testid="echarts-mock" />),
}));

describe('Sparkline', () => {
  it('renders without crashing', () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5, 4]} />);
    expect(container.querySelector('[data-testid="echarts-mock"]') ?? container.firstChild).toBeTruthy();
  });
});
```

Create `src/dashboard-client/tests/components/ui/Sankey.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sankey } from '../../../src/components/ui/Sankey';

const echartsSetOption = vi.fn();
vi.mock('echarts-for-react', () => {
  const React = require('react');
  return {
    default: React.forwardRef((_props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ setOption: echartsSetOption }));
      return React.createElement('div', { 'data-testid': 'echarts-mock' });
    }),
  };
});

describe('Sankey', () => {
  it('calls setOption with sankey series config', () => {
    const nodes = [{ name: 'prompt' }, { name: 'cache_read' }, { name: 'cost' }];
    const links = [
      { source: 'prompt', target: 'cache_read', value: 100 },
      { source: 'cache_read', target: 'cost', value: 100 },
    ];
    render(<Sankey nodes={nodes} links={links} />);
    expect(echartsSetOption).toHaveBeenCalled();
    const call = echartsSetOption.mock.calls[0][0];
    expect(call.series[0].type).toBe('sankey');
    expect(call.series[0].data).toEqual(nodes);
    expect(call.series[0].links).toEqual(links);
    echartsSetOption.mockClear();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `src/dashboard-client/`): `npx vitest run tests/components/ui/Sparkline.test.tsx tests/components/ui/Sankey.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create echarts-theme.ts**

Create `src/dashboard-client/src/lib/echarts-theme.ts`:

```typescript
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#7CFFA0';
}

export interface EchartsTheme {
  bg: string;
  fg: string;
  fg1: string;
  border: string;
  accent: string;
  warn: string;
  danger: string;
  info: string;
  fontMono: string;
}

export function getEchartsTheme(): EchartsTheme {
  return {
    bg: cssVar('--bg-1'),
    fg: cssVar('--fg-0'),
    fg1: cssVar('--fg-1'),
    border: cssVar('--border'),
    accent: cssVar('--accent'),
    warn: cssVar('--warn'),
    danger: cssVar('--danger'),
    info: cssVar('--info'),
    fontMono: cssVar('--font-mono'),
  };
}

export function commonGrid() {
  const t = getEchartsTheme();
  return {
    left: 48,
    right: 24,
    top: 24,
    bottom: 32,
    containLabel: true,
  };
}

export function commonAxis() {
  const t = getEchartsTheme();
  return {
    axisLine: { lineStyle: { color: t.border } },
    axisLabel: { color: t.fg1, fontFamily: t.fontMono, fontSize: 11 },
    splitLine: { lineStyle: { color: t.border, opacity: 0.3 } },
  };
}

export function commonTooltip() {
  const t = getEchartsTheme();
  return {
    backgroundColor: t.bg,
    borderColor: t.border,
    textStyle: { color: t.fg, fontFamily: t.fontMono, fontSize: 12 },
  };
}
```

- [ ] **Step 4: Create Sparkline.tsx**

Create `src/dashboard-client/src/components/ui/Sparkline.tsx`:

```tsx
import ReactECharts from 'echarts-for-react';
import { getEchartsTheme } from '../../lib/echarts-theme';

interface SparklineProps {
  data: number[];
  color?: string;
  height?: number;
}

export function Sparkline({ data, color, height = 32 }: SparklineProps) {
  const t = getEchartsTheme();
  const lineColor = color ?? t.accent;
  const option = {
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false, data: data.map((_, i) => i) },
    yAxis: { type: 'value', show: false },
    series: [{
      type: 'line',
      data,
      smooth: true,
      symbol: 'none',
      lineStyle: { color: lineColor, width: 1.5 },
      areaStyle: { color: lineColor, opacity: 0.15 },
    }],
    tooltip: { show: false },
  };
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />;
}
```

- [ ] **Step 5: Create LineChart.tsx**

Create `src/dashboard-client/src/components/ui/LineChart.tsx`:

```tsx
import ReactECharts from 'echarts-for-react';
import { getEchartsTheme, commonGrid, commonAxis, commonTooltip } from '../../lib/echarts-theme';

export interface LineSeries {
  name: string;
  data: number[];
  color?: string;
}

interface LineChartProps {
  series: LineSeries[];
  xLabels: string[];
  yLabel?: string;
  height?: number;
}

export function LineChart({ series, xLabels, yLabel, height = 240 }: LineChartProps) {
  const t = getEchartsTheme();
  const axis = commonAxis();
  const option = {
    grid: commonGrid(),
    tooltip: { ...commonTooltip(), trigger: 'axis' },
    xAxis: { type: 'category', data: xLabels, ...axis },
    yAxis: { type: 'value', name: yLabel, nameTextStyle: { color: t.fg1, fontFamily: t.fontMono }, ...axis },
    legend: {
      data: series.map(s => s.name),
      textStyle: { color: t.fg1, fontFamily: t.fontMono, fontSize: 11 },
      top: 0,
    },
    series: series.map(s => ({
      name: s.name,
      type: 'line',
      data: s.data,
      smooth: true,
      symbol: 'circle',
      symbolSize: 4,
      lineStyle: { color: s.color ?? t.accent, width: 2 },
      itemStyle: { color: s.color ?? t.accent },
    })),
  };
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />;
}
```

- [ ] **Step 6: Create StackedBar.tsx**

Create `src/dashboard-client/src/components/ui/StackedBar.tsx`:

```tsx
import ReactECharts from 'echarts-for-react';
import { getEchartsTheme, commonGrid, commonAxis, commonTooltip } from '../../lib/echarts-theme';

export interface BarSeries {
  name: string;
  data: number[];
  color?: string;
}

interface StackedBarProps {
  series: BarSeries[];
  xLabels: string[];
  height?: number;
}

export function StackedBar({ series, xLabels, height = 240 }: StackedBarProps) {
  const t = getEchartsTheme();
  const axis = commonAxis();
  const palette = [t.accent, t.info, t.warn, t.danger, t.fg1];
  const option = {
    grid: commonGrid(),
    tooltip: { ...commonTooltip(), trigger: 'axis' },
    xAxis: { type: 'category', data: xLabels, ...axis },
    yAxis: { type: 'value', ...axis },
    legend: {
      data: series.map(s => s.name),
      textStyle: { color: t.fg1, fontFamily: t.fontMono, fontSize: 11 },
      top: 0,
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: 'bar',
      stack: 'total',
      data: s.data,
      itemStyle: { color: s.color ?? palette[i % palette.length] },
    })),
  };
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />;
}
```

- [ ] **Step 7: Create Heatmap.tsx**

Create `src/dashboard-client/src/components/ui/Heatmap.tsx`:

```tsx
import ReactECharts from 'echarts-for-react';
import { getEchartsTheme, commonTooltip } from '../../lib/echarts-theme';

interface HeatmapPoint {
  x: string;
  y: string;
  value: number;
}

interface HeatmapProps {
  data: HeatmapPoint[];
  xLabels: string[];
  yLabels: string[];
  height?: number;
  valueRange?: [number, number];
}

export function Heatmap({ data, xLabels, yLabels, height = 240, valueRange }: HeatmapProps) {
  const t = getEchartsTheme();
  const values = data.map(d => d.value);
  const range = valueRange ?? [Math.min(...values), Math.max(...values)];
  const option = {
    tooltip: { ...commonTooltip() },
    grid: { left: 80, right: 24, top: 24, bottom: 32, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: t.fg1, fontFamily: t.fontMono, fontSize: 10 }, splitArea: { show: false } },
    yAxis: { type: 'category', data: yLabels, axisLabel: { color: t.fg1, fontFamily: t.fontMono, fontSize: 10 }, splitArea: { show: false } },
    visualMap: {
      min: range[0],
      max: range[1],
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: t.fg1, fontFamily: t.fontMono },
      inRange: { color: [t.border, t.warn, t.danger] },
    },
    series: [{
      type: 'heatmap',
      data: data.map(d => [xLabels.indexOf(d.x), yLabels.indexOf(d.y), d.value]),
      label: { show: false },
    }],
  };
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />;
}
```

- [ ] **Step 8: Create Sankey.tsx**

Create `src/dashboard-client/src/components/ui/Sankey.tsx`:

```tsx
import ReactECharts from 'echarts-for-react';
import { getEchartsTheme, commonTooltip } from '../../lib/echarts-theme';

export interface SankeyNode {
  name: string;
  color?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

interface SankeyProps {
  nodes: SankeyNode[];
  links: SankeyLink[];
  height?: number;
}

export function Sankey({ nodes, links, height = 320 }: SankeyProps) {
  const t = getEchartsTheme();
  const option = {
    tooltip: { ...commonTooltip(), trigger: 'item' },
    series: [{
      type: 'sankey',
      data: nodes.map(n => ({
        name: n.name,
        itemStyle: { color: n.color ?? t.fg1, borderColor: n.color ?? t.fg1 },
      })),
      links,
      label: { color: t.fg, fontFamily: t.fontMono, fontSize: 12 },
      lineStyle: { color: 'gradient', opacity: 0.4 },
      emphasis: { focus: 'adjacency' },
      layoutIterations: 32,
    }),
  };
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />;
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run (in `src/dashboard-client/`): `npx vitest run tests/components/ui/Sparkline.test.tsx tests/components/ui/Sankey.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 10: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/dashboard-client/src/lib/echarts-theme.ts src/dashboard-client/src/components/ui/Sparkline.tsx src/dashboard-client/src/components/ui/LineChart.tsx src/dashboard-client/src/components/ui/StackedBar.tsx src/dashboard-client/src/components/ui/Heatmap.tsx src/dashboard-client/src/components/ui/Sankey.tsx src/dashboard-client/tests/components/ui/Sparkline.test.tsx src/dashboard-client/tests/components/ui/Sankey.test.tsx
git commit -m "feat(dashboard): ECharts theme + chart wrappers (Sparkline, LineChart, StackedBar, Heatmap, Sankey)"
```

---

## Task 5: TanStack Query hooks for catalog + metrics + cache

**Files:**
- Create: `src/dashboard-client/src/hooks/useCatalog.ts`
- Create: `src/dashboard-client/src/hooks/useMetrics.ts`
- Create: `src/dashboard-client/src/hooks/useCache.ts`
- Modify: `src/dashboard-client/src/lib/api.ts` (add catalog/metrics/cache fetchers if not present)

**Interfaces:**
- Produces: `useCatalogModels(filters)`, `useCatalogModel(id)`, `useBenchmarks(filters)`, `usePricing()`. `useRuntimeMetrics(filters)`, `useTpsLeaderboard()`. `useCacheStats()`, `useCacheLeaderboard()`, `useRefreshCache(source)`. Each returns TanStack Query result.

- [ ] **Step 1: Check existing api.ts for fetch helpers**

Read `src/dashboard-client/src/lib/api.ts`. It already has `fetchJson` or similar for existing endpoints. Confirm the base URL handling (likely `process.env.DASHBOARD_API_URL` or relative `/api`).

- [ ] **Step 2: Create useCatalog.ts**

Create `src/dashboard-client/src/hooks/useCatalog.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CatalogModel {
  id: string;
  name: string;
  family: string | null;
  provider_id: string;
  release_date: string | null;
  attachment: number;
  reasoning: number;
  temperature: number;
  tool_call: number;
  context_limit: number | null;
  output_limit: number | null;
  status: string | null;
  reasoning_options: string | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

export interface CatalogModelFilters {
  provider?: string;
  reasoning?: '1' | '0';
  tool_call?: '1' | '0';
  min_context?: number;
  sort?: 'name' | 'context';
  q?: string;
}

export function useCatalogModels(filters: CatalogModelFilters = {}) {
  return useQuery({
    queryKey: ['catalog', 'models', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.provider) params.set('provider', filters.provider);
      if (filters.reasoning) params.set('reasoning', filters.reasoning);
      if (filters.tool_call) params.set('tool_call', filters.tool_call);
      if (filters.min_context) params.set('min_context', String(filters.min_context));
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.q) params.set('q', filters.q);
      const res = await api.get<{ data: CatalogModel[] }>(`/api/models?${params.toString()}`);
      return res.data;
    },
    refetchInterval: 60_000,
  });
}

export interface ModelDetail extends CatalogModel {
  modalities: string | null;
  input_limit: number | null;
  tier_size: number | null;
  over_200k_input: number | null;
  over_200k_output: number | null;
  over_200k_cache_read: number | null;
  over_200k_cache_write: number | null;
}

export interface BenchmarkRow {
  benchmark: string;
  source: string;
  score: number;
  measured_at: string;
  source_url: string | null;
  is_preferred: number;
}

export interface RuntimeStatRow {
  run_id: string;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tps: number | null;
  ttft_ms: number | null;
  cache_hit_rate: number | null;
  cost_usd: number | null;
  success: number;
  measured_at: string;
}

export interface ModelDetailResponse {
  model: ModelDetail;
  benchmarks: BenchmarkRow[];
  runtime: RuntimeStatRow[];
}

export function useCatalogModel(id: string) {
  return useQuery({
    queryKey: ['catalog', 'model', id],
    queryFn: async () => {
      const res = await api.get<ModelDetailResponse>(`/api/models/${encodeURIComponent(id)}`);
      return res;
    },
    enabled: !!id,
    refetchInterval: 30_000,
  });
}

export interface BenchmarkFilters {
  name?: string;
  source?: string;
  model?: string;
}

export function useBenchmarks(filters: BenchmarkFilters = {}) {
  return useQuery({
    queryKey: ['catalog', 'benchmarks', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.name) params.set('name', filters.name);
      if (filters.source) params.set('source', filters.source);
      if (filters.model) params.set('model', filters.model);
      const res = await api.get<{ data: BenchmarkRow[] }>(`/api/benchmarks?${params.toString()}`);
      return res.data;
    },
    refetchInterval: 300_000,
  });
}

export function usePricing(model?: string) {
  return useQuery({
    queryKey: ['catalog', 'pricing', model],
    queryFn: async () => {
      const url = model ? `/api/pricing?model=${encodeURIComponent(model)}` : '/api/pricing';
      const res = await api.get<{ data: Array<Record<string, unknown>> }>(url);
      return res.data;
    },
    refetchInterval: 300_000,
  });
}
```

- [ ] **Step 3: Create useMetrics.ts**

Create `src/dashboard-client/src/hooks/useMetrics.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { RuntimeStatRow } from './useCatalog';

export interface RuntimeMetricFilters {
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function useRuntimeMetrics(filters: RuntimeMetricFilters = {}) {
  return useQuery({
    queryKey: ['metrics', 'runtime', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.model) params.set('model', filters.model);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.limit) params.set('limit', String(filters.limit));
      const res = await api.get<{ data: RuntimeStatRow[] }>(`/api/metrics/runtime?${params.toString()}`);
      return res.data;
    },
    refetchInterval: 10_000,
  });
}

export interface TpsLeaderboardEntry {
  model_id: string;
  name: string;
  provider_id: string;
  avg_tps: number | null;
  max_tps: number | null;
  avg_latency_p50: number | null;
  avg_cache_hit_rate: number | null;
  run_count: number;
}

export function useTpsLeaderboard() {
  return useQuery({
    queryKey: ['metrics', 'tps'],
    queryFn: async () => {
      const res = await api.get<{ data: TpsLeaderboardEntry[] }>('/api/metrics/tps');
      return res.data;
    },
    refetchInterval: 10_000,
  });
}
```

- [ ] **Step 4: Create useCache.ts**

Create `src/dashboard-client/src/hooks/useCache.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CacheStateRow {
  source: string;
  last_fetch: string;
  last_status: string;
  last_error: string | null;
  count: number | null;
  next_refresh: string;
}

export function useCacheStats() {
  return useQuery({
    queryKey: ['cache', 'stats'],
    queryFn: async () => {
      const res = await api.get<{ data: CacheStateRow[] }>('/api/cache/stats');
      return res.data;
    },
    refetchInterval: 30_000,
  });
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  provider_id: string;
  context_limit: number | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  intelligence: number | null;
  coding: number | null;
  arena_tps: number | null;
  arena_latency: number | null;
  arena_runs: number;
}

export function useCacheLeaderboard() {
  return useQuery({
    queryKey: ['cache', 'leaderboard'],
    queryFn: async () => {
      const res = await api.get<{ data: LeaderboardEntry[] }>('/api/cache/leaderboard');
      return res.data;
    },
    refetchInterval: 15_000,
  });
}

export function useRefreshCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (source: string) => {
      return api.post<{ ok: boolean; count: number; error?: string }>('/api/cache/refresh', { source });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cache'] });
      qc.invalidateQueries({ queryKey: ['catalog'] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}
```

- [ ] **Step 5: Ensure api.ts has get/post helpers**

Read `src/dashboard-client/src/lib/api.ts`. If it already has `api.get` / `api.post` style helpers using `fetch` with auth header injection, skip. If not, add a minimal wrapper:

```typescript
export const api = {
  async get<T>(url: string): Promise<T> {
    const token = localStorage.getItem('arena_token');
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    return res.json();
  },
  async post<T>(url: string, body: unknown): Promise<T> {
    const token = localStorage.getItem('arena_token');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${url}: ${res.status}`);
    return res.json();
  },
};
```

Match the existing token storage key (read existing `api.ts` to confirm — it may use a different key or context).

- [ ] **Step 6: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard-client/src/hooks/useCatalog.ts src/dashboard-client/src/hooks/useMetrics.ts src/dashboard-client/src/hooks/useCache.ts src/dashboard-client/src/lib/api.ts
git commit -m "feat(dashboard): TanStack Query hooks for catalog, metrics, and cache endpoints"
```
---

## Task 6: Nav shell + SettingsProvider + theme toggle + routes

**Files:**
- Create: `src/dashboard-client/src/providers/SettingsProvider.tsx`
- Create: `src/dashboard-client/src/components/Nav.tsx`
- Create: `src/dashboard-client/src/components/CacheStatePill.tsx`
- Modify: `src/dashboard-client/src/App.tsx` (rewrite routes + nav)
- Create: `src/dashboard-client/tests/pages/Home.test.tsx` (placeholder smoke)

**Interfaces:**
- Produces: `SettingsProvider` exposing `theme: 'auto'|'dark'|'light'`, `setTheme()`, persists to localStorage, syncs to `document.documentElement.dataset.theme`. `Nav` with logo + links + `CacheStatePill` + theme toggle + user menu. `App.tsx` routes all 8 pages + login gate.

- [ ] **Step 1: Create SettingsProvider.tsx**

Create `src/dashboard-client/src/providers/SettingsProvider.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'auto' | 'dark' | 'light';

interface SettingsContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const STORAGE_KEY = 'arena_theme';

function resolveTheme(t: Theme): 'dark' | 'light' {
  if (t === 'dark') return 'dark';
  if (t === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof localStorage === 'undefined') return 'dark';
    return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'dark';
  });

  useEffect(() => {
    const resolved = resolveTheme(theme);
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <SettingsContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
```

- [ ] **Step 2: Create CacheStatePill.tsx**

Create `src/dashboard-client/src/components/CacheStatePill.tsx`:

```tsx
import { useCacheStats } from '../hooks/useCache';
import { cn } from '../lib/cn';

export function CacheStatePill() {
  const { data, isLoading } = useCacheStats();
  if (isLoading || !data) {
    return <span className="font-mono text-12 text-fg-1">cache: …</span>;
  }
  const hasError = data.some(s => s.last_status === 'error');
  const allFresh = data.every(s => new Date(s.next_refresh).getTime() > Date.now());
  const status = hasError ? 'error' : allFresh ? 'fresh' : 'stale';
  const colorClass = status === 'error' ? 'text-danger border-danger' : status === 'stale' ? 'text-warn border-warn' : 'text-accent border-accent';
  const label = status === 'error' ? 'cache error' : `cache: ${data.length} sources`;
  return (
    <span className={cn('inline-flex items-center gap-4 rounded-inner border px-8 py-4 font-mono text-12', colorClass)}>
      {label}
    </span>
  );
}
```

- [ ] **Step 3: Create Nav.tsx**

Create `src/dashboard-client/src/components/Nav.tsx`:

```tsx
import { NavLink } from 'react-router-dom';
import { useSettings } from '../providers/SettingsProvider';
import { CacheStatePill } from './CacheStatePill';
import { cn } from '../lib/cn';

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/compare', label: 'Compare' },
  { to: '/ops', label: 'Ops' },
  { to: '/settings', label: 'Settings' },
];

export function Nav() {
  const { theme, setTheme } = useSettings();
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark';
  return (
    <nav className="sticky top-0 z-50 flex h-64 items-center justify-between border-b border-border bg-bg-0/95 px-24 backdrop-blur">
      <div className="flex items-center gap-32">
        <span className="font-display text-20 font-700 text-accent">AI_ARENA</span>
        <div className="flex gap-4">
          {LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) => cn(
                'px-12 py-8 font-display text-14 font-500 transition-colors duration-80 ease-out-quart',
                isActive ? 'text-accent' : 'text-fg-1 hover:text-fg-0',
              )}
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-16">
        <CacheStatePill />
        <button
          onClick={() => setTheme(nextTheme)}
          aria-label={`Toggle theme (current: ${theme})`}
          className="h-40 w-40 rounded-inner hover:bg-bg-2 font-mono text-14 text-fg-1 hover:text-fg-0"
        >
          {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
        </button>
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Rewrite App.tsx**

Modify `src/dashboard-client/src/App.tsx`. Replace existing routes with:

```tsx
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

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 5: Create placeholder page stubs**

For each new page file (`Home.tsx`, `Catalog.tsx`, `ModelDetail.tsx`, `Leaderboard.tsx`, `Compare.tsx`, `Ops.tsx`, `Settings.tsx`), create a minimal stub so the app compiles. Example for `Home.tsx`:

```tsx
export function Home() {
  return <div className="font-display text-28">Mission Control (placeholder)</div>;
}
```

Repeat for each page with its name. `RunDetail.tsx` and `Login.tsx` already exist — leave them.

- [ ] **Step 6: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS (stubs compile).

- [ ] **Step 7: Commit**

```bash
git add src/dashboard-client/src/providers/SettingsProvider.tsx src/dashboard-client/src/components/Nav.tsx src/dashboard-client/src/components/CacheStatePill.tsx src/dashboard-client/src/App.tsx src/dashboard-client/src/pages/Home.tsx src/dashboard-client/src/pages/Catalog.tsx src/dashboard-client/src/pages/ModelDetail.tsx src/dashboard-client/src/pages/Leaderboard.tsx src/dashboard-client/src/pages/Compare.tsx src/dashboard-client/src/pages/Ops.tsx src/dashboard-client/src/pages/Settings.tsx
git commit -m "feat(dashboard): nav shell + SettingsProvider + routes + page stubs"
```

---

## Task 7: Home page (mission control) with Sankey

**Files:**
- Modify: `src/dashboard-client/src/pages/Home.tsx` (full implementation)
- Create: `src/dashboard-client/src/components/Launcher.tsx`
- Create: `tests/pages/Home.test.tsx`

**Interfaces:**
- Produces: full Home page with 3 StatTiles, Token Flow Sankey, Top TPS MetricBars, Recent Runs table, Anomalies strip, Launcher modal.

- [ ] **Step 1: Write the failing test**

Create `src/dashboard-client/tests/pages/Home.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Home } from '../../../src/pages/Home';

vi.mock('echarts-for-react', () => ({
  default: () => <div data-testid="echarts-mock" />,
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Home', () => {
  it('renders the mission control heading', () => {
    renderWithProviders(<Home />);
    expect(screen.getByText(/Mission Control/i)).toBeInTheDocument();
  });

  it('renders the token flow sankey panel', () => {
    renderWithProviders(<Home />);
    expect(screen.getByText(/Token Flow/i)).toBeInTheDocument();
  });

  it('renders the launcher button', () => {
    renderWithProviders(<Home />);
    expect(screen.getByRole('button', { name: /Run/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `src/dashboard-client/`): `npx vitest run tests/pages/Home.test.tsx`
Expected: FAIL — stub doesn't render expected content.

- [ ] **Step 3: Create Launcher.tsx**

Create `src/dashboard-client/src/components/Launcher.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './ui/Modal';
import { Select } from './ui/Select';
import { Button } from './ui/Button';
import { useCatalogModels } from '../hooks/useCatalog';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Scenario {
  name: string;
  description?: string;
}

interface LauncherProps {
  open: boolean;
  onClose: () => void;
}

export function Launcher({ open, onClose }: LauncherProps) {
  const navigate = useNavigate();
  const [scenario, setScenario] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const { data: models } = useCatalogModels({ tool_call: '1' });
  const { data: scenarios } = useQuery({
    queryKey: ['scenarios'],
    queryFn: async () => (await api.get<{ data: Scenario[] }>('/api/scenarios')).data,
  });
  const [submitting, setSubmitting] = useState(false);

  async function handleLaunch() {
    if (!scenario || selectedModels.length === 0) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ runId: string }>('/api/runs', { scenario, models: selectedModels });
      onClose();
      navigate(`/runs/${res.runId}`);
    } finally {
      setSubmitting(false);
    }
  }

  function toggleModel(name: string) {
    setSelectedModels(prev => prev.includes(name) ? prev.filter(m => m !== name) : [...prev, name]);
  }

  return (
    <Modal open={open} onClose={onClose} title="Launch Run">
      <div className="flex flex-col gap-16">
        <Select
          label="Scenario"
          value={scenario}
          onChange={setScenario}
          options={(scenarios ?? []).map(s => ({ value: s.name, label: s.name }))}
        />
        <div>
          <span className="font-body text-12 text-fg-1 uppercase">Models</span>
          <div className="mt-8 max-h-200 overflow-y-auto rounded-inner border border-border p-8">
            {(models ?? []).map(m => (
              <label key={m.id} className="flex items-center gap-8 py-4 hover:bg-bg-2 px-8 rounded-inner">
                <input
                  type="checkbox"
                  checked={selectedModels.includes(m.name)}
                  onChange={() => toggleModel(m.name)}
                  className="accent-accent"
                />
                <span className="font-mono text-14">{m.name}</span>
                <span className="font-body text-12 text-fg-1">— {m.provider_id}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-8">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleLaunch} disabled={!scenario || selectedModels.length === 0 || submitting}>
            Launch
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Implement Home.tsx**

Replace `src/dashboard-client/src/pages/Home.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { StatTile } from '../components/ui/StatTile';
import { MetricBar } from '../components/ui/MetricBar';
import { Button } from '../components/ui/Button';
import { Sankey, type SankeyNode, type SankeyLink } from '../components/ui/Sankey';
import { EmptyState } from '../components/ui/EmptyState';
import { Launcher } from '../components/Launcher';
import { useTpsLeaderboard } from '../hooks/useMetrics';
import { useRuntimeMetrics } from '../hooks/useMetrics';
import { useCacheStats } from '../hooks/useCache';

export function Home() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const { data: tpsData } = useTpsLeaderboard();
  const { data: runtime } = useRuntimeMetrics({ limit: 20 });
  const { data: cacheStats } = useCacheStats();

  const activeRuns = runtime?.filter(r => r.success === 0 && r.run_id).length ?? 0;
  const modelCount = tpsData?.length ?? 0;
  const cacheSources = cacheStats?.length ?? 0;

  // Sankey: aggregate tokens from recent runtime stats
  const recentRuntime = runtime ?? [];
  const totalPrompt = recentRuntime.reduce((sum, r) => sum + (r.cache_hit_rate ?? 0), 0);
  const totalCacheRead = recentRuntime.reduce((sum, r) => sum + Math.round((r.cache_hit_rate ?? 0) * 1000), 0);
  const totalCompletion = recentRuntime.reduce((sum, r) => sum + Math.round((r.tps ?? 0) * 10), 0);
  const totalCost = recentRuntime.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  const sankeyNodes: SankeyNode[] = [
    { name: 'prompt' },
    { name: 'cache_read', color: 'var(--accent)' },
    { name: 'completion', color: 'var(--warn)' },
    { name: 'cost', color: 'var(--danger)' },
  ];
  const sankeyLinks: SankeyLink[] = [
    { source: 'prompt', target: 'cache_read', value: Math.max(1, totalCacheRead) },
    { source: 'prompt', target: 'completion', value: Math.max(1, totalCompletion) },
    { source: 'cache_read', target: 'cost', value: Math.max(1, Math.round(totalCost * 1000)) },
    { source: 'completion', target: 'cost', value: Math.max(1, Math.round(totalCost * 1000)) },
  ];

  const topTps = (tpsData ?? []).slice(0, 3);
  const recentRuns = (runtime ?? []).slice(0, 5);

  return (
    <div className="flex flex-col gap-24">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-44 font-700">Mission Control</h1>
        <Button onClick={() => setLauncherOpen(true)}>+ Run</Button>
      </div>

      <div className="grid grid-cols-3 gap-16">
        <StatTile value={activeRuns} label="Active runs" />
        <StatTile value={modelCount} label="Models in DB" />
        <StatTile value={cacheSources} label="Cache sources" />
      </div>

      <Panel>
        <PanelHeader title="Token Flow" actions={<span className="font-mono text-12 text-fg-1">live</span>} />
        <PanelBody>
          {recentRuntime.length === 0 ? (
            <EmptyState title="No runs yet" description="Launch a run to see token flow." />
          ) : (
            <Sankey nodes={sankeyNodes} links={sankeyLinks} />
          )}
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-2 gap-16">
        <Panel>
          <PanelHeader title="Top TPS" />
          <PanelBody>
            {topTps.length === 0 ? (
              <EmptyState title="No TPS data" />
            ) : (
              <div className="flex flex-col gap-12">
                {topTps.map(m => (
                  <MetricBar
                    key={m.model_id}
                    label={m.name}
                    value={m.avg_tps ?? 0}
                    min={0}
                    max={Math.max(...topTps.map(t => t.avg_tps ?? 0), 1)}
                  />
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Recent Runs" />
          <PanelBody>
            {recentRuns.length === 0 ? (
              <EmptyState title="No recent runs" />
            ) : (
              <div className="flex flex-col">
                {recentRuns.map(r => (
                  <Link
                    key={r.run_id}
                    to={`/runs/${r.run_id}`}
                    className="flex items-center justify-between border-b border-border/50 py-8 hover:bg-bg-2 px-8 rounded-inner"
                  >
                    <span className="font-mono text-14">{r.run_id}</span>
                    <span className={r.success ? 'text-accent font-mono text-14' : 'text-danger font-mono text-14'}>
                      {r.success ? '✓' : '✗'}
                    </span>
                    <span className="font-mono text-14 text-fg-1" data-numeric>{r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '-'}</span>
                  </Link>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Launcher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (in `src/dashboard-client/`): `npx vitest run tests/pages/Home.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard-client/src/pages/Home.tsx src/dashboard-client/src/components/Launcher.tsx src/dashboard-client/tests/pages/Home.test.tsx
git commit -m "feat(dashboard): Home mission control page with Sankey + launcher"
```
---

## Task 8: Catalog browser page

**Files:**
- Modify: `src/dashboard-client/src/pages/Catalog.tsx` (full implementation)
- Create: `tests/pages/Catalog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard-client/tests/pages/Catalog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Catalog } from '../../../src/pages/Catalog';

vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="echarts-mock" /> }));

vi.mock('../../../src/hooks/useCatalog', () => ({
  useCatalogModels: () => ({
    data: [
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai', reasoning: 0, tool_call: 1, context_limit: 128000, input: 2.5, output: 10, status: null },
      { id: 'anthropic/claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic', reasoning: 1, tool_call: 1, context_limit: 200000, input: 3, output: 15, status: 'beta' },
    ],
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('Catalog', () => {
  it('renders the catalog heading', () => {
    renderWithProviders(<Catalog />);
    expect(screen.getByText(/Catalog/i)).toBeInTheDocument();
  });

  it('renders model rows from query', () => {
    renderWithProviders(<Catalog />);
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('Claude 3.7 Sonnet')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `src/dashboard-client/`): `npx vitest run tests/pages/Catalog.test.tsx`
Expected: FAIL — stub has no table.

- [ ] **Step 3: Implement Catalog.tsx**

Replace `src/dashboard-client/src/pages/Catalog.tsx`:

```tsx
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { useCatalogModels, type CatalogModel, type CatalogModelFilters } from '../hooks/useCatalog';

const PROVIDER_OPTIONS = [
  { value: '', label: 'All providers' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'nvidia', label: 'NVIDIA' },
];

export function Catalog() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<CatalogModelFilters>({});
  const [text, setText] = useState('');
  const { data, isLoading, error, refetch } = useCatalogModels(filters);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!text) return data;
    const q = text.toLowerCase();
    return data.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [data, text]);

  const columns: Column<CatalogModel>[] = [
    { key: 'name', header: 'Name', sortable: true, render: m => <span className="font-mono text-14 text-fg-0">{m.name}</span> },
    { key: 'provider_id', header: 'Provider', sortable: true, render: m => <Badge variant="provider" value={m.provider_id} /> },
    { key: 'context_limit', header: 'Context', sortable: true, render: m => <span data-numeric>{m.context_limit?.toLocaleString() ?? '-'}</span> },
    { key: 'reasoning', header: 'Reason', render: m => m.reasoning ? <Badge variant="reasoning" value="reason" /> : <span className="text-fg-1">-</span> },
    { key: 'tool_call', header: 'Tools', render: m => m.tool_call ? <span className="text-accent">✓</span> : <span className="text-fg-1">-</span> },
    { key: 'input', header: 'In $/M', sortable: true, render: m => <span data-numeric>{m.input != null ? `$${m.input}` : '-'}</span> },
    { key: 'output', header: 'Out $/M', sortable: true, render: m => <span data-numeric>{m.output != null ? `$${m.output}` : '-'}</span> },
    { key: 'cache_read', header: 'Cache $/M', render: m => <span data-numeric className="text-fg-1">{m.cache_read != null ? `$${m.cache_read}` : '-'}</span> },
    { key: 'status', header: 'Status', render: m => m.status ? <Badge variant="status" value={m.status} /> : <span className="text-fg-1">stable</span> },
  ];

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Catalog</h1>
      <Panel>
        <div className="flex flex-wrap items-center gap-12 pb-16 border-b border-border">
          <Select
            label="Provider"
            value={filters.provider ?? ''}
            onChange={v => setFilters(f => ({ ...f, provider: v || undefined }))}
            options={PROVIDER_OPTIONS}
            className="w-160"
          />
          <Select
            label="Reasoning"
            value={filters.reasoning ?? ''}
            onChange={v => setFilters(f => ({ ...f, reasoning: (v || undefined) as '1' | '0' }))}
            options={[{ value: '', label: 'Any' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' }]}
            className="w-120"
          />
          <Select
            label="Tools"
            value={filters.tool_call ?? ''}
            onChange={v => setFilters(f => ({ ...f, tool_call: (v || undefined) as '1' | '0' }))}
            options={[{ value: '', label: 'Any' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' }]}
            className="w-120"
          />
          <label className="flex flex-col gap-4">
            <span className="font-body text-12 text-fg-1 uppercase">Min context</span>
            <input
              type="number"
              placeholder="0"
              value={filters.min_context ?? ''}
              onChange={e => setFilters(f => ({ ...f, min_context: e.target.value ? Number(e.target.value) : undefined }))}
              className="h-40 w-120 px-12 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
          <label className="flex flex-col gap-4 flex-1 min-w-200">
            <span className="font-body text-12 text-fg-1 uppercase">Search</span>
            <input
              type="text"
              placeholder="model name or id..."
              value={text}
              onChange={e => setText(e.target.value)}
              className="h-40 px-12 rounded-inner border border-border bg-bg-2 font-mono text-14 text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
        </div>
        {isLoading ? <div className="flex justify-center py-48"><Spinner /></div>
        : error ? <ErrorState message="Failed to load catalog" onRetry={() => refetch()} />
        : <DataTable columns={columns} data={filtered} onRowClick={m => navigate(`/catalog/${encodeURIComponent(m.id)}`)} getRowId={m => m.id} />}
        <div className="pt-8 text-right font-mono text-12 text-fg-1">{filtered.length} models</div>
      </Panel>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (in `src/dashboard-client/`): `npx vitest run tests/pages/Catalog.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-client/src/pages/Catalog.tsx src/dashboard-client/tests/pages/Catalog.test.tsx
git commit -m "feat(dashboard): Catalog browser with filter bar + DataTable"
```

---

## Task 9: Model detail page

**Files:**
- Modify: `src/dashboard-client/src/pages/ModelDetail.tsx` (full implementation)

- [ ] **Step 1: Implement ModelDetail.tsx**

Replace `src/dashboard-client/src/pages/ModelDetail.tsx`:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Tabs } from '../components/ui/Tabs';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { LineChart } from '../components/ui/LineChart';
import { StackedBar } from '../components/ui/StackedBar';
import { useCatalogModel, type BenchmarkRow, type RuntimeStatRow } from '../hooks/useCatalog';

export function ModelDetail() {
  const { id = '' } = useParams();
  const decodedId = decodeURIComponent(id);
  const { data, isLoading, error, refetch } = useCatalogModel(decodedId);
  const [tab, setTab] = useState('overview');

  if (isLoading) return <div className="flex justify-center py-48"><Spinner /></div>;
  if (error) return <ErrorState message="Failed to load model" onRetry={() => refetch()} />;
  if (!data) return <EmptyState title="Model not found" />;

  const { model, benchmarks, runtime } = data;

  const benchmarkGroups = benchmarks.reduce<Record<string, BenchmarkRow[]>>((acc, b) => {
    (acc[b.benchmark] ??= []).push(b);
    return acc;
  }, {});

  const runtimeLabels = runtime.map(r => new Date(r.measured_at).toLocaleDateString());
  const latencySeries = [
    { name: 'p50', data: runtime.map(r => r.latency_p50_ms ?? 0) },
    { name: 'p95', data: runtime.map(r => r.latency_p95_ms ?? 0) },
  ];
  const tpsSeries = [{ name: 'TPS', data: runtime.map(r => r.tps ?? 0) }];
  const tokenSeries = [
    { name: 'cache_read', data: runtime.map(r => Math.round((r.cache_hit_rate ?? 0) * 1000)) },
    { name: 'cost', data: runtime.map(r => Math.round((r.cost_usd ?? 0) * 1000)) },
  ];

  return (
    <div className="flex flex-col gap-16">
      <header className="flex flex-wrap items-center gap-16">
        <h1 className="font-display text-44 font-700">{model.name}</h1>
        <Badge variant="provider" value={model.provider_id} />
        {model.status && <Badge variant="status" value={model.status} />}
        {model.reasoning && <Badge variant="reasoning" value="reason" />}
        {model.family && <span className="font-mono text-14 text-fg-1">{model.family}</span>}
      </header>

      <div className="grid grid-cols-4 gap-12">
        <Panel className="p-12"><div className="font-body text-12 text-fg-1 uppercase">Context</div><div className="font-display text-20 font-600" data-numeric>{model.context_limit?.toLocaleString() ?? '-'}</div></Panel>
        <Panel className="p-12"><div className="font-body text-12 text-fg-1 uppercase">Output</div><div className="font-display text-20 font-600" data-numeric>{model.output_limit?.toLocaleString() ?? '-'}</div></Panel>
        <Panel className="p-12"><div className="font-body text-12 text-fg-1 uppercase">Input $/M</div><div className="font-display text-20 font-600" data-numeric>{model.input != null ? `$${model.input}` : '-'}</div></Panel>
        <Panel className="p-12"><div className="font-body text-12 text-fg-1 uppercase">Output $/M</div><div className="font-display text-20 font-600" data-numeric>{model.output != null ? `$${model.output}` : '-'}</div></Panel>
      </div>

      <Tabs
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'benchmarks', label: 'Benchmarks' },
          { id: 'metrics', label: 'Arena metrics' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <Panel>
          <PanelHeader title="Capabilities" />
          <PanelBody>
            <div className="grid grid-cols-2 gap-8 font-mono text-14">
              <div>Attachment: <span className="text-accent">{model.attachment ? 'yes' : 'no'}</span></div>
              <div>Temperature: <span className="text-accent">{model.temperature ? 'yes' : 'no'}</span></div>
              <div>Tool calls: <span className="text-accent">{model.tool_call ? 'yes' : 'no'}</span></div>
              <div>Reasoning: <span className="text-accent">{model.reasoning ? 'yes' : 'no'}</span></div>
            </div>
            {model.reasoning_options && (
              <div className="mt-16">
                <div className="font-body text-12 text-fg-1 uppercase mb-8">Reasoning options</div>
                <pre className="font-mono text-12 text-fg-1 bg-bg-0 p-12 rounded-inner overflow-x-auto">{model.reasoning_options}</pre>
              </div>
            )}
          </PanelBody>
        </Panel>
      )}

      {tab === 'benchmarks' && (
        <div className="flex flex-col gap-16">
          {Object.keys(benchmarkGroups).length === 0 ? (
            <EmptyState title="No benchmarks" description="This model has no benchmark data yet." />
          ) : (
            Object.entries(benchmarkGroups).map(([name, rows]) => (
              <Panel key={name}>
                <PanelHeader title={name} />
                <PanelBody>
                  <div className="flex flex-col gap-4">
                    {rows.map(r => (
                      <div key={r.source} className="flex items-center justify-between border-b border-border/50 py-8 last:border-0">
                        <span className="font-mono text-14">{r.source}{r.is_preferred ? ' ★' : ''}</span>
                        <span className="font-display text-20 font-600 text-accent" data-numeric>{r.score.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </PanelBody>
              </Panel>
            ))
          )}
        </div>
      )}

      {tab === 'metrics' && (
        <div className="flex flex-col gap-16">
          {runtime.length === 0 ? (
            <EmptyState title="No arena runs yet" description="Trigger a run from Home to see live metrics." />
          ) : (
            <>
              <Panel>
                <PanelHeader title="Latency over time" />
                <PanelBody><LineChart series={latencySeries} xLabels={runtimeLabels} yLabel="ms" /></PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="TPS over time" />
                <PanelBody><LineChart series={tpsSeries} xLabels={runtimeLabels} yLabel="tokens/s" /></PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="Cache + cost breakdown" />
                <PanelBody><StackedBar series={tokenSeries} xLabels={runtimeLabels} /></PanelBody>
              </Panel>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard-client/src/pages/ModelDetail.tsx
git commit -m "feat(dashboard): Model detail page with caps/benchmarks/arena-metrics tabs"
```

---

## Task 10: Leaderboard + Compare + Ops + Settings pages

**Files:**
- Modify: `src/dashboard-client/src/pages/Leaderboard.tsx`
- Modify: `src/dashboard-client/src/pages/Compare.tsx`
- Modify: `src/dashboard-client/src/pages/Ops.tsx`
- Modify: `src/dashboard-client/src/pages/Settings.tsx`

- [ ] **Step 1: Implement Leaderboard.tsx**

Replace `src/dashboard-client/src/pages/Leaderboard.tsx`:

```tsx
import { useState } from 'react';
import { Panel } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { useCacheLeaderboard, type LeaderboardEntry } from '../hooks/useCache';
import { Button } from '../components/ui/Button';

const COLUMNS: Column<LeaderboardEntry>[] = [
  { key: 'name', header: 'Model', sortable: true, render: m => <span className="font-mono text-14 text-fg-0">{m.name}</span> },
  { key: 'provider_id', header: 'Provider', sortable: true, render: m => <Badge variant="provider" value={m.provider_id} /> },
  { key: 'context_limit', header: 'Context', sortable: true, render: m => <span data-numeric>{m.context_limit?.toLocaleString() ?? '-'}</span> },
  { key: 'input', header: 'In $/M', sortable: true, render: m => <span data-numeric>{m.input != null ? `$${m.input}` : '-'}</span> },
  { key: 'output', header: 'Out $/M', sortable: true, render: m => <span data-numeric>{m.output != null ? `$${m.output}` : '-'}</span> },
  { key: 'intelligence', header: 'Intelligence', sortable: true, render: m => <span data-numeric className="text-accent">{m.intelligence != null ? m.intelligence.toFixed(1) : '-'}</span> },
  { key: 'coding', header: 'Coding', sortable: true, render: m => <span data-numeric>{m.coding != null ? m.coding.toFixed(1) : '-'}</span> },
  { key: 'arena_tps', header: 'Arena TPS', sortable: true, render: m => <span data-numeric>{m.arena_tps != null ? m.arena_tps.toFixed(1) : '-'}</span> },
  { key: 'arena_latency', header: 'Arena p50', sortable: true, render: m => <span data-numeric>{m.arena_latency != null ? `${Math.round(m.arena_latency)}ms` : '-'}</span> },
  { key: 'arena_runs', header: 'Runs', sortable: true, render: m => <span data-numeric>{m.arena_runs}</span> },
];

export function Leaderboard() {
  const { data, isLoading, error, refetch } = useCacheLeaderboard();
  const [onlyWithArena, setOnlyWithArena] = useState(false);

  const filtered = (data ?? []).filter(m => !onlyWithArena || m.arena_runs > 0);

  function exportCsv() {
    if (!filtered.length) return;
    const headers = COLUMNS.map(c => c.header).join(',');
    const rows = filtered.map(m => COLUMNS.map(c => String((m as Record<string, unknown>)[c.key] ?? '')).join(','));
    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leaderboard.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-16">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-28 font-600">Leaderboard</h1>
        <div className="flex gap-8">
          <Button variant="ghost" size="sm" onClick={() => setOnlyWithArena(v => !v)}>
            {onlyWithArena ? '✓ ' : ''}Arena data only
          </Button>
          <Button variant="ghost" size="sm" onClick={exportCsv}>Export CSV</Button>
        </div>
      </div>
      <Panel>
        {isLoading ? <div className="flex justify-center py-48"><Spinner /></div>
        : error ? <ErrorState message="Failed to load leaderboard" onRetry={() => refetch()} />
        : filtered.length === 0 ? <EmptyState title="No models" />
        : <DataTable columns={COLUMNS} data={filtered} getRowId={m => m.id} />}
        <div className="pt-8 text-right font-mono text-12 text-fg-1">{filtered.length} models</div>
      </Panel>
    </div>
  );
}
```

- [ ] **Step 2: Implement Compare.tsx**

Replace `src/dashboard-client/src/pages/Compare.tsx`:

```tsx
import { useState } from 'react';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Select } from '../components/ui/Select';
import { EmptyState } from '../components/ui/EmptyState';
import { useCatalogModels, type CatalogModel } from '../hooks/useCatalog';
import { useBenchmarks } from '../hooks/useCatalog';
import { Badge } from '../components/ui/Badge';

function ModelColumn({ model, benchmarks }: { model: CatalogModel; benchmarks: ReturnType<typeof useBenchmarks>['data'] }) {
  const modelBenchmarks = (benchmarks ?? []).filter(b => b.model_id === model.id);
  return (
    <div className="flex flex-col gap-12">
      <h3 className="font-display text-20 font-600">{model.name}</h3>
      <Badge variant="provider" value={model.provider_id} />
      <div className="font-mono text-14">
        <div>Context: <span className="text-fg-0">{model.context_limit?.toLocaleString() ?? '-'}</span></div>
        <div>Input: <span className="text-fg-0">${model.input ?? '-'}</span></div>
        <div>Output: <span className="text-fg-0">${model.output ?? '-'}</span></div>
        <div>Cache: <span className="text-fg-0">${model.cache_read ?? '-'}</span></div>
        <div>Reasoning: <span className="text-accent">{model.reasoning ? 'yes' : 'no'}</span></div>
      </div>
      {modelBenchmarks.length > 0 && (
        <div className="mt-8">
          <div className="font-body text-12 text-fg-1 uppercase mb-4">Benchmarks</div>
          {modelBenchmarks.filter(b => b.is_preferred).map(b => (
            <div key={b.benchmark} className="flex justify-between font-mono text-12 py-2">
              <span className="text-fg-1">{b.benchmark}</span>
              <span className="text-accent" data-numeric>{b.score.toFixed(1)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Compare() {
  const { data: models } = useCatalogModels();
  const { data: benchmarks } = useBenchmarks();
  const [selected, setSelected] = useState<string[]>(['', '', '', '']);

  const modelOptions = (models ?? []).map(m => ({ value: m.id, label: m.name }));
  const selectedModels = selected
    .map(id => (models ?? []).find(m => m.id === id))
    .filter((m): m is CatalogModel => !!m);

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Compare</h1>
      <div className="grid grid-cols-4 gap-12">
        {selected.map((id, i) => (
          <Select
            key={i}
            value={id}
            onChange={v => setSelected(prev => prev.map((s, idx) => idx === i ? v : s))}
            options={[{ value: '', label: '— select —' }, ...modelOptions]}
          />
        ))}
      </div>
      <Panel>
        {selectedModels.length < 2 ? (
          <EmptyState title="Pick 2-4 models to compare" description="Select models from the dropdowns above." />
        ) : (
          <div className={`grid gap-16 grid-cols-${selectedModels.length}`}>
            {selectedModels.map(m => <ModelColumn key={m.id} model={m} benchmarks={benchmarks} />)}
          </div>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 3: Implement Ops.tsx**

Replace `src/dashboard-client/src/pages/Ops.tsx`:

```tsx
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { useCacheStats } from '../hooks/useCache';
import { useRefreshCache } from '../hooks/useCache';
import { useLive } from '../hooks/useLive';

export function Ops() {
  const { data: cacheStats, isLoading } = useCacheStats();
  const refresh = useRefreshCache();
  const { processes } = useLive();

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Ops Console</h1>

      <Panel>
        <PanelHeader title="PM2 Processes" />
        <PanelBody>
          {(processes?.length ?? 0) === 0 ? (
            <EmptyState title="No active workers" />
          ) : (
            <table className="w-full font-mono text-14">
              <thead><tr className="text-fg-1 text-12 uppercase border-b border-border">
                <th className="px-8 py-8 text-left">Name</th><th className="px-8 py-8 text-left">Status</th>
                <th className="px-8 py-8 text-right">CPU</th><th className="px-8 py-8 text-right">Mem</th>
                <th className="px-8 py-8 text-left">Run</th>
              </tr></thead>
              <tbody>
                {(processes ?? []).map(p => (
                  <tr key={p.name} className="border-b border-border/50 hover:bg-bg-2">
                    <td className="px-8 py-8">{p.name}</td>
                    <td className="px-8 py-8"><Badge variant="status" value={p.status} /></td>
                    <td className="px-8 py-8 text-right" data-numeric>{p.cpu?.toFixed(1)}%</td>
                    <td className="px-8 py-8 text-right" data-numeric>{p.memory?.toFixed(0)}MB</td>
                    <td className="px-8 py-8 text-fg-1">{p.runId ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-3 gap-16">
        {(cacheStats ?? []).map(s => (
          <Panel key={s.source}>
            <PanelHeader title={s.source} actions={
              <Button variant="ghost" size="sm" onClick={() => refresh.mutate(s.source)} disabled={refresh.isPending}>
                Refresh
              </Button>
            } />
            <PanelBody>
              {isLoading ? <Spinner /> : (
                <div className="font-mono text-14 flex flex-col gap-4">
                  <div>Status: <span className={s.last_status === 'ok' ? 'text-accent' : 'text-danger'}>{s.last_status}</span></div>
                  <div>Count: <span data-numeric>{s.count ?? 0}</span></div>
                  <div>Last fetch: <span className="text-fg-1">{new Date(s.last_fetch).toLocaleString()}</span></div>
                  <div>Next refresh: <span className="text-fg-1">{new Date(s.next_refresh).toLocaleString()}</span></div>
                  {s.last_error && <div className="text-danger text-12 mt-8">{s.last_error}</div>}
                </div>
              )}
            </PanelBody>
          </Panel>
        ))}
        {!cacheStats && !isLoading && <Panel><EmptyState title="No cache data" /></Panel>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement Settings.tsx (consolidated)**

Replace `src/dashboard-client/src/pages/Settings.tsx`:

```tsx
import { useState } from 'react';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Tabs } from '../components/ui/Tabs';
import { Button } from '../components/ui/Button';
import { useSettings } from '../providers/SettingsProvider';

export function Settings() {
  const [tab, setTab] = useState('general');
  const { theme, setTheme } = useSettings();

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Settings</h1>
      <Tabs
        items={[
          { id: 'general', label: 'General' },
          { id: 'auth', label: 'Auth' },
          { id: 'scenarios', label: 'Scenarios' },
          { id: 'providers', label: 'Providers' },
          { id: 'notifications', label: 'Notifications' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'general' && (
        <Panel>
          <PanelHeader title="Theme" />
          <PanelBody>
            <div className="flex gap-8">
              {(['auto', 'dark', 'light'] as const).map(t => (
                <Button key={t} variant={theme === t ? 'primary' : 'ghost'} onClick={() => setTheme(t)}>
                  {t}
                </Button>
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}

      {tab === 'auth' && (
        <Panel><PanelHeader title="Authentication" /><PanelBody><p className="font-body text-14 text-fg-1">JWT and API key management — see server configuration.</p></PanelBody></Panel>
      )}
      {tab === 'scenarios' && (
        <Panel><PanelHeader title="Scenarios" /><PanelBody><p className="font-body text-14 text-fg-1">Scenario CRUD — embed ScenarioForm here (moved from /scenarios).</p></PanelBody></Panel>
      )}
      {tab === 'providers' && (
        <Panel><PanelHeader title="Providers" /><PanelBody><p className="font-body text-14 text-fg-1">Custom provider CRUD — mirror of Ops providers table.</p></PanelBody></Panel>
      )}
      {tab === 'notifications' && (
        <Panel><PanelHeader title="Notifications" /><PanelBody><p className="font-body text-14 text-fg-1">Webhook management — existing webhooks CRUD.</p></PanelBody></Panel>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run typecheck + lint**

Run from root: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-client/src/pages/Leaderboard.tsx src/dashboard-client/src/pages/Compare.tsx src/dashboard-client/src/pages/Ops.tsx src/dashboard-client/src/pages/Settings.tsx
git commit -m "feat(dashboard): Leaderboard + Compare + Ops + Settings pages"
```
