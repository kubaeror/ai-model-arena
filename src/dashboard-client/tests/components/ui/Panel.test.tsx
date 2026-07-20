import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel, PanelHeader, PanelBody } from '../../../src/components/ui/Panel';

describe('Panel', () => {
  it('renders children inside PanelBody', () => {
    render(<Panel><PanelBody>Test content</PanelBody></Panel>);
    expect(screen.getByText('Test content')).toBeInTheDocument();
  });

  it('renders title in PanelHeader when provided', () => {
    render(<Panel><PanelHeader title="My Panel" /></Panel>);
    expect(screen.getByText('My Panel')).toBeInTheDocument();
  });

  it('renders actions in PanelHeader when provided', () => {
    render(<Panel><PanelHeader title="Panel" actions={<button>Action</button>} /></Panel>);
    expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  });
});
