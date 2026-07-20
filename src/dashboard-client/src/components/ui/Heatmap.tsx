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
