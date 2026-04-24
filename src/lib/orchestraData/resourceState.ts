export type OrchestraInitialLoadState = "idle" | "loading" | "ready" | "error";

export interface OrchestraResourceStatus {
  initialLoad: OrchestraInitialLoadState;
  refreshing: boolean;
  mutating: boolean;
  hasData: boolean;
  stale: boolean;
}

export function deriveOrchestraInitialLoadState(options: {
  loading: boolean;
  hasData: boolean;
  error: boolean;
}): OrchestraInitialLoadState {
  if (options.loading && !options.hasData) {
    return "loading";
  }
  if (options.error && !options.hasData) {
    return "error";
  }
  return options.hasData ? "ready" : "idle";
}
