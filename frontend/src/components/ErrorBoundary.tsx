import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Icon } from './Icon';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Runtime label used for console grouping, e.g. "page" or "app". */
  level?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Class-based boundary so a crash inside a child page (bad data shape,
// third-party chart error, …) shows a recoverable panel instead of a blank
// window. Mount with a `key` to get automatic recovery on re-navigation.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[get-Hike] ${this.props.level || 'app'} crashed:`, error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="page-container"
        role="alert"
        style={{ minHeight: '56vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        <div
          style={{
            maxWidth: 440,
            width: '100%',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: 24,
            textAlign: 'center',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'color-mix(in srgb, var(--accent-red) 15%, transparent)',
              color: 'var(--danger-text)',
              marginBottom: 12,
            }}
          >
            <Icon name="info" size={22} />
          </span>
          <h2 style={{ margin: '0 0 6px', fontSize: 17, color: 'var(--text-primary)' }}>
            This view hit an unexpected error
          </h2>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
            {error.message || 'A child component failed to render.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={this.handleReset}>
              Try again
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
