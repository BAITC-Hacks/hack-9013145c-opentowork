import { Component } from "react";
import type { ReactNode } from "react";

/** При смене сборки отложенный JS может исчезнуть: рабочий экран сохраняем в 2D. */
export default class SceneBoundary extends Component<{
  children: ReactNode;
  fallback?: ReactNode;
  onUnavailable?: () => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onUnavailable?.();
  }

  render() {
    return this.state.failed ? this.props.fallback ?? null : this.props.children;
  }
}
