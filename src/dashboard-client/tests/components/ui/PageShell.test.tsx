import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageShell } from '../../../src/components/ui/PageShell';

describe('PageShell', () => {
  it('renders the title in a heading', () => {
    render(
      <MemoryRouter>
        <PageShell title="Test Page"><p>Content</p></PageShell>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Test Page' })).toBeInTheDocument();
  });

  it('renders a description when provided', () => {
    render(
      <MemoryRouter>
        <PageShell title="Test" description="A helpful description"><p>Content</p></PageShell>
      </MemoryRouter>,
    );
    expect(screen.getByText('A helpful description')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(
      <MemoryRouter>
        <PageShell title="Test"><p>Child content</p></PageShell>
      </MemoryRouter>,
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders breadcrumbs when provided', () => {
    render(
      <MemoryRouter>
        <PageShell
          title="Details"
          breadcrumbs={[{ label: 'Home', to: '/' }, { label: 'Detail Page' }]}
        >
          <p>Content</p>
        </PageShell>
      </MemoryRouter>,
    );
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Detail Page')).toBeInTheDocument();
  });

  it('renders actions in the header', () => {
    render(
      <MemoryRouter>
        <PageShell title="Test" actions={<button>Action Button</button>}>
          <p>Content</p>
        </PageShell>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Action Button' })).toBeInTheDocument();
  });

  it('renders skeleton shell when loading', () => {
    render(
      <MemoryRouter>
        <PageShell title="LoadingPage" loading><p>Content</p></PageShell>
      </MemoryRouter>,
    );
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
    const skeletons = document.querySelectorAll('[aria-hidden="true"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('sets document title on mount', () => {
    render(
      <MemoryRouter>
        <PageShell title="My Page"><p>Content</p></PageShell>
      </MemoryRouter>,
    );
    expect(document.title).toBe('My Page — AI Model Arena');
  });
});
