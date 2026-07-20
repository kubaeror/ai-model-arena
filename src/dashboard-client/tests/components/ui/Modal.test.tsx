import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../../../src/components/ui/Modal';

describe('Modal', () => {
  it('renders title and children when open', () => {
    render(<Modal open={true} onClose={() => {}} title="Test Modal"><p>Content</p></Modal>);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Test"><p>Content</p></Modal>);
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('calls onClose when ESC pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose} title="Test"><p>Content</p></Modal>);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when overlay clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose} title="Test"><p>Content</p></Modal>);
    const overlay = document.querySelector('[data-overlay="true"]') as HTMLElement;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });
});
