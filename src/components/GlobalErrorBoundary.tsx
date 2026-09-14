/**
 * Global Error Boundary — CP73.
 * Não expõe stack trace em produção.
 */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  reportId: string;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, reportId: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
      reportId: `err-${Date.now().toString(36)}`,
    };
  }

  componentDidCatch(error: Error): void {
    if (import.meta.env.DEV) {
      console.error('[GlobalErrorBoundary]', error);
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null, reportId: '' });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const isDev = import.meta.env.DEV;
    const message = this.state.error?.message ?? 'Erro inesperado';

    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
        <div className="bg-[#111] border border-red-500/30 rounded-xl p-8 max-w-lg w-full text-center">
          <h2 className="text-lg font-bold text-[#eee] mb-2">Erro ao carregar o sistema</h2>
          <p className="text-sm text-[#888] mb-2">
            Ocorreu um erro. Você pode tentar novamente ou contatar o administrador.
          </p>
          <p className="text-xs text-[#666] mb-4">Report ID: {this.state.reportId}</p>
          {isDev ? (
            <pre className="text-xs text-red-400/80 text-left mb-4 overflow-auto max-h-32">{message}</pre>
          ) : (
            <p className="text-sm text-[#aaa] mb-4">{message}</p>
          )}
          <button
            type="button"
            onClick={this.handleRetry}
            className="px-4 py-2 text-sm bg-[#c9a96e] text-[#111] rounded"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }
}

/** @deprecated alias GlobalErrorBoundary */
export const ErrorBoundary = GlobalErrorBoundary;
