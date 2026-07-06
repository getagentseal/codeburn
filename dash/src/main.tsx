import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { App } from './App'
import './index.css'

// Last-resort guard: a render error (e.g. an unexpected payload from a peer on
// a different version) shows a recoverable message instead of a blank page.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-outer-background p-8 text-center">
          <p className="text-sm text-foreground">Something went wrong rendering the dashboard.</p>
          <p className="max-w-md text-xs text-tertiary-foreground">{String(this.state.error.message)}</p>
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-interactive-secondary"
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000, retry: 1 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
