import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export type PushToast = (kind: ToastKind, text: string) => void;

const TOAST_MS = 8000;

export function useToasts(): { toasts: Toast[]; push: PushToast; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<PushToast>((kind, text) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setToasts((prev) => [...prev, { id, kind, text }]);
  }, []);

  return { toasts, push, dismiss };
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  // The timer belongs to the rendered toast, so it survives StrictMode's effect re-run.
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className={`toast toast--${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span className="toast__text">{toast.text}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Đóng thông báo"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

export function ToastList({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
