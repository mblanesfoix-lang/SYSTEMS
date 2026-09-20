import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Etiqueta de la zona protegida, para que el aviso diga que ha fallado. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Red de seguridad de render. Sin esto, cualquier excepcion dentro de un
 * componente desmonta TODO el arbol de React y el usuario ve una pantalla en
 * blanco, sin pista de que ha pasado. Con esto el fallo queda acotado a su
 * zona y el resto de la interfaz sigue usable.
 *
 * Tiene que ser una clase: React no ofrece equivalente en hooks.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Queda en consola para diagnosticar; el usuario ve el aviso de abajo.
    console.error('[Rëff] Error de render' + (this.props.label ? ` en ${this.props.label}` : ''), error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="card"
        style={{
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderColor: 'rgba(255,107,107,0.38)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: '#ff6b6b' }}>
          No se ha podido mostrar {this.props.label ?? 'este contenido'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          El dato recibido no tiene el formato esperado. El resto de la pantalla sigue funcionando.
        </div>
        <code style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
          {error.message}
        </code>
        <div>
          <button className="btn-secondary" onClick={() => this.setState({ error: null })}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }
}
