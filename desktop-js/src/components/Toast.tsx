import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { ToastContext, type ToastKind } from './toastContext'

type ToastItem = {
  id: number
  kind: ToastKind
  message: string
  ttl: number
}

let nextToastId = 1

/**
 * Lightweight toast notification provider. Toasts auto-dismiss after
 * `ttl` ms (default 4000). The container is rendered globally and
 * respects prefers-reduced-motion via CSS.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info', ttl = 4000) => {
      const id = nextToastId++
      setToasts((current) => [...current, { id, kind, message, ttl }])
    },
    [],
  )

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="toast-container" role="region">
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    const handle = window.setTimeout(onDismiss, toast.ttl)
    return () => window.clearTimeout(handle)
  }, [onDismiss, toast.ttl])

  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertTriangle : Info

  return (
    <div className={`toast ${toast.kind}`} role="status">
      <Icon size={15} />
      <span>{toast.message}</span>
      <button aria-label="Dismiss notification" className="ghost icon-only" onClick={onDismiss} type="button">
        <X size={13} />
      </button>
    </div>
  )
}
