import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../lib/errorToast';
import { useT } from '../lib/i18n';

// The SPA and the API deploy on independent pipelines (Cloudflare Workers vs
// Railway), so for a few minutes after every release a new bundle talks to the
// old backend. A render that reads a field the old response doesn't carry used
// to unmount the whole root — a blank document on every route, surviving a
// reload. One boundary per shell turns that into a page that says what to do.

function Fallback({ onReload }: { onReload: () => void }) {
  const { t } = useT();
  return (
    <div style={{
      minHeight: '60vh', display: 'grid', placeItems: 'center', padding: 24,
    }}>
      <div className="card" style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{t('errBoundaryTitle')}</div>
        <div style={{ color: 'var(--fg-subtle)', fontSize: 13, marginBottom: 16 }}>
          {t('errBoundaryBody')}
        </div>
        <button type="button" className="btn primary" onClick={onReload}>
          {t('errBoundaryReload')}
        </button>
      </div>
    </div>
  );
}

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Whoever gets called still needs the stack, and nothing else captures it.
    console.error('[render]', error, info.componentStack);
    // A crash here is invisible server-side — the render never made a request,
    // so no backend log records it. Ship it, or the only evidence is a console
    // the user has already closed.
    reportClientError({
      kind: 'render',
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <Fallback onReload={() => window.location.reload()} />;
  }
}
