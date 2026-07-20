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
