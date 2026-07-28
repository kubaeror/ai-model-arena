import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette, type CommandItem } from '../../../src/components/CommandPalette';

function renderPalette(overrides: { query?: string } = {}) {
  const filtered: CommandItem[] = [
    { id: 'home', label: 'Home', href: '/', category: 'Pages' },
    { id: 'catalog', label: 'Catalog', href: '/catalog', category: 'Pages' },
    { id: 'settings', label: 'Settings', href: '/settings', category: 'Pages' },
  ];
  const inputRef = { current: null as HTMLInputElement | null };
  return render(
    <MemoryRouter>
      <CommandPalette
        open={true}
        onClose={vi.fn()}
        query={overrides.query ?? ''}
        onQueryChange={vi.fn()}
        filtered={filtered}
        selectedIndex={0}
        selected={filtered[0]}
        inputRef={inputRef}
        onKeyDown={vi.fn()}
        onSelect={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const filtered: CommandItem[] = [];
    const inputRef = { current: null as HTMLInputElement | null };
    const { container } = render(
      <MemoryRouter>
        <CommandPalette
          open={false}
          onClose={vi.fn()}
          query=""
          onQueryChange={vi.fn()}
          filtered={filtered}
          selectedIndex={0}
          selected={undefined}
          inputRef={inputRef}
          onKeyDown={vi.fn()}
          onSelect={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders search input when open', () => {
    renderPalette();
    expect(screen.getByPlaceholderText(/Search pages/i)).toBeInTheDocument();
  });

  it('shows filtered results', () => {
    renderPalette();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Catalog')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows category labels', () => {
    renderPalette();
    const categoryLabels = screen.getAllByText('Pages');
    expect(categoryLabels.length).toBeGreaterThanOrEqual(3);
  });

  it('shows empty state when no results', () => {
    const filtered: CommandItem[] = [];
    const inputRef = { current: null as HTMLInputElement | null };
    render(
      <MemoryRouter>
        <CommandPalette
          open={true}
          onClose={vi.fn()}
          query="zzz"
          onQueryChange={vi.fn()}
          filtered={filtered}
          selectedIndex={0}
          selected={undefined}
          inputRef={inputRef}
          onKeyDown={vi.fn()}
          onSelect={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No results/i)).toBeInTheDocument();
  });

  it('has a close button', () => {
    renderPalette();
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });
});
