import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ToastProvider } from './components/Toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { runQuantSelfTests } from './data/quantMath.tests'
// Note: useToast is exported separately from ./components/useToast so the
// Toast.tsx file can be hot-reloaded without breaking React Refresh.

// Run quant-math self-tests in dev so silent numerical bugs surface in
// the browser console at every reload. Results print as one info line
// when all pass, or detailed errors when any fail.
if (import.meta.env.DEV) {
  runQuantSelfTests()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
)
