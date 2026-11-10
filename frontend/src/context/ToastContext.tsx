import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, ReactNode } from 'react';
import { Icon } from '../components/Icon';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  dismissToast: (id: string) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Auto-dismiss timers are tracked per toast id so dismissing a toast
  // manually cancels its pending timeout, and unmounting the provider
  // (StrictMode double-mount / HMR in dev) never fires a setter afterwards.
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearTimerFor = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    clearTimerFor(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, [clearTimerFor]);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration: number = 4000) => {
      const id = Math.random().toString(36).substring(2, 9);
      const newToast: Toast = { id, type, message, duration };
      setToasts((prev) => [...prev.slice(-4), newToast]); // keep at most 5

      if (duration > 0) {
        const existing = timersRef.current.get(id);
        if (existing !== undefined) clearTimeout(existing);
        timersRef.current.set(
          id,
          setTimeout(() => {
            timersRef.current.delete(id);
            setToasts((prev) => prev.filter((t) => t.id !== id));
          }, duration)
        );
      }
    },
    []
  );

  const success = useCallback((msg: string, d?: number) => showToast(msg, 'success', d), [showToast]);
  const error = useCallback((msg: string, d?: number) => showToast(msg, 'error', d), [showToast]);
  const warning = useCallback((msg: string, d?: number) => showToast(msg, 'warning', d), [showToast]);
  const info = useCallback((msg: string, d?: number) => showToast(msg, 'info', d), [showToast]);

  const value = useMemo(
    () => ({ toasts, showToast, dismissToast, success, error, warning, info }),
    [toasts, showToast, dismissToast, success, error, warning, info]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item toast-${toast.type}`} role="status">
            <span className="toast-icon">
              {toast.type === 'success' && <Icon name="check" size={16} />}
              {toast.type === 'error' && <Icon name="x" size={16} />}
              {toast.type === 'warning' && <Icon name="info" size={16} />}
              {toast.type === 'info' && <Icon name="info" size={16} />}
            </span>
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextType {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
