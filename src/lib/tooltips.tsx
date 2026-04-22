import { createContext, useCallback, useContext, type ReactNode } from "react";

export const ORCHESTRA_EXPLANATORY_TOOLTIPS_STORAGE_KEY = "orchestra.preferences.explanatory-tooltips";
export const DEFAULT_EXPLANATORY_TOOLTIPS_ENABLED = true;

const ExplanatoryTooltipsContext = createContext<boolean>(DEFAULT_EXPLANATORY_TOOLTIPS_ENABLED);

export interface ExplanatoryTooltipProps {
  title?: string;
  "data-tooltip"?: string;
}

function normalizeTooltipPreference(value: string | null | undefined) {
  if (value === "disabled" || value === "false") {
    return false;
  }
  if (value === "enabled" || value === "true") {
    return true;
  }
  return DEFAULT_EXPLANATORY_TOOLTIPS_ENABLED;
}

export function loadStoredExplanatoryTooltips(storage: Pick<Storage, "getItem"> = window.localStorage) {
  return normalizeTooltipPreference(storage.getItem(ORCHESTRA_EXPLANATORY_TOOLTIPS_STORAGE_KEY));
}

export function storeExplanatoryTooltips(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> = window.localStorage,
) {
  storage.setItem(ORCHESTRA_EXPLANATORY_TOOLTIPS_STORAGE_KEY, enabled ? "enabled" : "disabled");
}

export function applyExplanatoryTooltips(enabled: boolean, doc: Document = document) {
  const value = enabled ? "enabled" : "disabled";
  doc.documentElement.dataset.explanatoryTooltips = value;
  if (doc.body) {
    doc.body.dataset.explanatoryTooltips = value;
  }
}

export function getExplanatoryTooltipProps(copy: string | null | undefined, enabled: boolean): ExplanatoryTooltipProps {
  const tooltip = copy?.trim();
  if (!enabled || !tooltip) {
    return {};
  }
  return {
    title: tooltip,
    "data-tooltip": tooltip,
  };
}

export function ExplanatoryTooltipsProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <ExplanatoryTooltipsContext.Provider value={enabled}>
      {children}
    </ExplanatoryTooltipsContext.Provider>
  );
}

export function useExplanatoryTooltipsEnabled() {
  return useContext(ExplanatoryTooltipsContext);
}

export function useExplanatoryTooltipProps() {
  const enabled = useExplanatoryTooltipsEnabled();
  return useCallback((copy: string | null | undefined) => getExplanatoryTooltipProps(copy, enabled), [enabled]);
}
