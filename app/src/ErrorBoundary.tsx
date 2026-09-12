import { Component, type ReactNode } from "react";

/**
 * A render error must never white-screen the demo: a judge, or the recording,
 * gets a readable panel instead, carrying the one link that always explains the
 * system. Nothing onchain is touched by a client-side render failure.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <main>
        <section className="stepcard" data-state="failed">
          <div className="stepcard__head">
            <span className="stepno" aria-hidden="true">
              !
            </span>
            <div className="steptitle">
              <h2>The ledger hit a render error</h2>
              <p className="what">The chain state is untouched. This is the viewer only.</p>
            </div>
            <span className="stepstate">error</span>
          </div>
          <div className="body">
            <div className="notice error" role="alert">
              <strong>Render error.</strong> {error.message}
            </div>
            <button className="primary" type="button" onClick={() => window.location.reload()}>
              Reload the ledger
            </button>
            <p className="caption" style={{ marginTop: 10 }}>
              Or read how it works:{" "}
              <a
                href="https://github.com/Aliserag/OpenBook/blob/main/docs/architecture.md"
                target="_blank"
                rel="noreferrer"
              >
                architecture ↗
              </a>
            </p>
          </div>
        </section>
      </main>
    );
  }
}
