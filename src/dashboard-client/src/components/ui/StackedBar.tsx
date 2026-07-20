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
