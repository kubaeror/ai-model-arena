import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const borderColor = {
    success: 'border-accent',
    error: 'border-danger',
    warning: 'border-warn',
    info: 'border-info',
  };

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-200 flex flex-col gap-2" aria-live="polite">
        {toasts.map(t => (
          <div
            key={t.id}
            className={cn(
              'flex items-center gap-2 rounded-panel border bg-bg-1 px-4 py-3 shadow-lg max-w-sm',
              borderColor[t.type],
            )}
          >
            <span className="font-mono text-14 text-fg-0 flex-1">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="text-fg-1 hover:text-fg-0"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
