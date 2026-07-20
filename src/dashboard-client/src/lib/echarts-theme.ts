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
