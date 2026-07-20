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
