declare global {
  interface Window {
    __orchestraInputPerfStats?: {
      renderCounts: Record<string, number>;
    };
    __orchestraTestInputPerfStats?: () => {
      renderCounts: Record<string, number>;
    };
    __orchestraResetInputPerfStats?: () => {
      renderCounts: Record<string, number>;
    };
  }
}

function canRecordInputPerf() {
  return typeof window !== "undefined" && Boolean(window.navigator?.webdriver);
}

export function recordInputPerfRender(key: string) {
  if (!canRecordInputPerf()) {
    return;
  }

  const current = window.__orchestraInputPerfStats ?? { renderCounts: {} };
  current.renderCounts[key] = (current.renderCounts[key] ?? 0) + 1;
  window.__orchestraInputPerfStats = current;

  if (!window.__orchestraTestInputPerfStats) {
    window.__orchestraTestInputPerfStats = () => ({
      renderCounts: { ...(window.__orchestraInputPerfStats?.renderCounts ?? {}) },
    });
  }

  if (!window.__orchestraResetInputPerfStats) {
    window.__orchestraResetInputPerfStats = () => {
      window.__orchestraInputPerfStats = { renderCounts: {} };
      return { renderCounts: {} };
    };
  }
}
