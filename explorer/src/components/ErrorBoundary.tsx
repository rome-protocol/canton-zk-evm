import { Component, type ReactNode } from "react";

/** Catches a page that fails while drawing, so the header and the search box stay. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    return this.state.failed ? (
      <section className="card nf">
        <h1>Something went wrong</h1>
        <p>This page could not be drawn. Reload it, or use the search box to go somewhere else.</p>
      </section>
    ) : this.props.children;
  }
}
