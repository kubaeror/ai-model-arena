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
