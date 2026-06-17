import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches render errors anywhere below and shows a recovery card instead
 * of letting React 19 unmount the whole app. Without this, a single
 * undefined-property access in any panel takes down the entire UI —
 * which is what just happened with the cached BacktestPanel result.
 */

type Props = { children: ReactNode }
type State = { error: Error | null; errorInfo: ErrorInfo | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ error, errorInfo })
    console.error('Error boundary caught:', error, errorInfo)
  }

  reset = (): void => {
    this.setState({ error: null, errorInfo: null })
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>Something broke in the UI.</h1>
          <p>
            The error is captured here so the rest of the app stays alive. Reload the page to
            recover, or click below to dismiss this view.
          </p>
          <pre>{this.state.error.message}</pre>
          <details>
            <summary>Stack trace</summary>
            <pre>{this.state.error.stack}</pre>
          </details>
          <div className="error-boundary-actions">
            <button className="primary" onClick={() => window.location.reload()} type="button">
              Reload app
            </button>
            <button onClick={this.reset} type="button">
              Try to dismiss
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
