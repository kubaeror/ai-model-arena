import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sankey } from '../../../src/components/ui/Sankey';

vi.mock('echarts-for-react', () => ({
  default: vi.fn(() => <div data-testid="echarts-mock" />),
}));

describe('Sankey', () => {
  it('renders without crashing', () => {
    const nodes = [{ name: 'prompt' }, { name: 'cache_read' }, { name: 'cost' }];
    const links = [
      { source: 'prompt', target: 'cache_read', value: 100 },
      { source: 'cache_read', target: 'cost', value: 100 },
    ];
    const { container } = render(<Sankey nodes={nodes} links={links} />);
    expect(container.querySelector('[data-testid="echarts-mock"]')).toBeTruthy();
  });
});
