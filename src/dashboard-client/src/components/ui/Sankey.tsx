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
    }],
  };
  return <ReactECharts option={option} style={{ height, width: '100%' }} opts={{ renderer: 'svg' }} />;
}
