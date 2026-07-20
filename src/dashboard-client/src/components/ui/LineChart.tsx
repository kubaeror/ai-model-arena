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
