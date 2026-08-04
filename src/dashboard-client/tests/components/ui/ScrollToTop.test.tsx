import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ScrollToTop } from '../../../src/components/ScrollToTop';

describe('ScrollToTop', () => {
  it('renders nothing (returns null)', () => {
    const { container } = render(
      <MemoryRouter>
        <ScrollToTop />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });
});
