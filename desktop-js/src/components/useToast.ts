import { useContext } from 'react'
import { ToastContext } from './toastContext'

/**
 * Hook for showing toasts. Lives in its own module so the Toast component
 * file can be hot-reloaded without violating the
 * react-refresh/only-export-components rule.
 */
export function useToast() {
  const value = useContext(ToastContext)
  if (!value) {
    return { showToast: () => undefined as void }
  }
  return value
}
