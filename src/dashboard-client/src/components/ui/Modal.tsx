import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { Button } from './Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      <div
        data-overlay="true"
        onClick={onClose}
        className="absolute inset-0 bg-bg-0/80"
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          'relative z-10 w-full max-w-600 mx-24 rounded-panel border border-border bg-bg-1 p-24 shadow-lg',
          className,
        )}
      >
        <header className="flex items-center justify-between mb-16">
          <h2 id="modal-title" className="font-display text-20 font-600">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
