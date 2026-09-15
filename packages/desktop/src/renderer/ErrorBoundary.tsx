/**
 * Error Boundary — catches render errors to prevent white screen.
 */
import * as React from 'react';

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: `${error.name}: ${error.message}\n${error.stack ?? ''}` };
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return React.createElement(
        'pre',
        {
          style: {
            padding: '20px',
            color: '#f85149',
            background: '#0d1117',
            fontFamily: 'monospace',
            fontSize: '13px',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            height: '100vh',
            margin: 0,
          },
        },
        this.state.error,
      );
    }
    return this.props.children;
  }
}
