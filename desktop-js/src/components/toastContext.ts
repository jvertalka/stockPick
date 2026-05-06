import { createContext } from 'react'

export type ToastKind = 'success' | 'info' | 'error'

export type ToastContextValue = {
  showToast: (message: string, kind?: ToastKind, ttl?: number) => void
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined)
