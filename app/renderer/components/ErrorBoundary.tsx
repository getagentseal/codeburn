import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null; stack: string | null }

/**
 * Catches render/lifecycle errors in a screen so a single crashing section
 * shows a readable error instead of white-screening the whole app. Keyed by
 * section in App, so navigating to another screen remounts and recovers.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the renderer console for diagnosis in dev.
    console.error('Screen crashed:', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? null })
  }

  render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className="error-boundary">
        <div className="panel error-card">
          <h3 className="error-title">This screen hit an error</h3>
          <p className="error-msg">{error.message || String(error)}</p>
          {stack && <pre className="error-stack">{stack.trim()}</pre>}
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
