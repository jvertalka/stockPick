import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ToastProvider } from './components/Toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { runQuantSelfTests } from './data/quantMath.tests'
// Note: useToast is exported separately from ./components/useToast so the
// Toast.tsx file can be hot-reloaded without breaking React Refresh.

// The packaged workstation is the primary runtime, so the same deterministic
// textbook checks run in every build. A numerical failure pauses the decision
// surface instead of allowing corrupted recommendations to reach the user.
const quantTestFailures = runQuantSelfTests().filter((result) => !result.passed)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        {quantTestFailures.length === 0 ? (
          <App />
        ) : (
          <div className="error-boundary" role="alert">
            <h1>Quantitative self-check failed.</h1>
            <p>
              Recommendations are paused because a textbook numerical check did not match its
              reference value. Reload after repairing the quantitative engine.
            </p>
            <ul>
              {quantTestFailures.map((failure) => (
                <li key={failure.name}>
                  <strong>{failure.name}</strong>
                  {failure.detail ? ` — ${failure.detail}` : ''}
                </li>
              ))}
            </ul>
            <div className="error-boundary-actions">
              <button className="primary" onClick={() => window.location.reload()} type="button">
                Re-run self-checks
              </button>
            </div>
          </div>
        )}
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
)
