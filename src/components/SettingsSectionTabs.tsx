import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface SettingsSectionTab {
  id: string;
  label: string;
  panel: ReactNode;
  hidden?: boolean;
}

interface SettingsSectionTabsProps {
  className?: string;
  header?: ReactNode;
  leadingContent?: ReactNode;
  tabs: SettingsSectionTab[];
  ariaLabel: string;
  dataRolePrefix: string;
  initialTabId?: string;
  activeTabId?: string;
  onTabChange?: (tabId: string) => void;
}

interface FloatingDockLayout {
  left: number;
  right: number;
}

const FLOATING_DOCK_SCROLL_EPSILON = 2;
const FLOATING_DOCK_DIRECTION_THRESHOLD = 28;

export function resolveVisibleSettingsSectionTab(
  tabs: readonly Pick<SettingsSectionTab, "id" | "hidden">[],
  activeTabId: string,
  initialTabId?: string,
) {
  const visibleTabs = tabs.filter((tab) => !tab.hidden);
  if (!visibleTabs.length) {
    return "";
  }
  if (visibleTabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  if (initialTabId && visibleTabs.some((tab) => tab.id === initialTabId)) {
    return initialTabId;
  }
  return visibleTabs[0]!.id;
}

function findScrollRoot(element: HTMLElement | null) {
  let currentAncestor = element?.parentElement ?? null;
  while (currentAncestor) {
    const styles = window.getComputedStyle(currentAncestor);
    if (["auto", "scroll", "overlay"].includes(styles.overflowY)) {
      return currentAncestor;
    }
    currentAncestor = currentAncestor.parentElement;
  }
  return null;
}

export function SettingsSectionTabs({
  className,
  header,
  leadingContent,
  tabs,
  ariaLabel,
  dataRolePrefix,
  initialTabId,
  activeTabId,
  onTabChange,
}: SettingsSectionTabsProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [uncontrolledActiveTab, setUncontrolledActiveTab] = useState(initialTabId ?? tabs.find((tab) => !tab.hidden)?.id ?? "");
  const [dockLayout, setDockLayout] = useState<FloatingDockLayout | null>(null);
  const [dockShown, setDockShown] = useState(true);
  const visibleTabs = useMemo(() => tabs.filter((tab) => !tab.hidden), [tabs]);
  const resolvedActiveTab = resolveVisibleSettingsSectionTab(visibleTabs, activeTabId ?? uncontrolledActiveTab, initialTabId);

  useEffect(() => {
    if (activeTabId !== undefined || resolvedActiveTab === uncontrolledActiveTab) {
      return;
    }
    setUncontrolledActiveTab(resolvedActiveTab);
  }, [activeTabId, resolvedActiveTab, uncontrolledActiveTab]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || visibleTabs.length < 2 || typeof window === "undefined") {
      setDockLayout(null);
      setDockShown(true);
      return;
    }

    const contentRoot = root.closest(".content") as HTMLElement | null;
    const scrollRoot = findScrollRoot(root) ?? contentRoot;
    let frameId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const getScrollPosition = () => Math.max(scrollRoot?.scrollTop ?? 0, window.scrollY, root.ownerDocument.documentElement.scrollTop);
    let lastScrollPosition = getScrollPosition();
    let accumulatedDirection: "up" | "down" | null = null;
    let accumulatedDistance = 0;
    let pendingScrollIntent: "up" | "down" | null = null;

    const updateLayout = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        const rect = root.getBoundingClientRect();
        const nextLayout = rect.width > 0 && rect.bottom > 96
          ? {
              left: Math.max(rect.left, 12),
              right: Math.max(window.innerWidth - rect.right, 12),
            }
          : null;
        const scrollPosition = getScrollPosition();
        const nextEligible = Boolean(nextLayout) && scrollPosition > 24;

        setDockLayout((current) => {
          if (!nextLayout && !current) {
            return current;
          }
          if (current && nextLayout && current.left === nextLayout.left && current.right === nextLayout.right) {
            return current;
          }
          return nextLayout;
        });

        if (!nextEligible) {
          accumulatedDirection = null;
          accumulatedDistance = 0;
          pendingScrollIntent = null;
          lastScrollPosition = scrollPosition;
          setDockShown((current) => (current === true ? current : true));
          return;
        }

        if (pendingScrollIntent) {
          const nextShown = pendingScrollIntent === "up";
          pendingScrollIntent = null;
          setDockShown((current) => (current === nextShown ? current : nextShown));
        }
      });
    };

    updateLayout();
    const handleScroll = () => {
      const scrollPosition = getScrollPosition();
      const delta = scrollPosition - lastScrollPosition;
      lastScrollPosition = scrollPosition;

      if (Math.abs(delta) >= FLOATING_DOCK_SCROLL_EPSILON) {
        const nextDirection = delta > 0 ? "down" : "up";
        if (accumulatedDirection !== nextDirection) {
          accumulatedDirection = nextDirection;
          accumulatedDistance = Math.abs(delta);
        } else {
          accumulatedDistance += Math.abs(delta);
        }

        if (accumulatedDistance >= FLOATING_DOCK_DIRECTION_THRESHOLD) {
          pendingScrollIntent = nextDirection;
          accumulatedDistance = 0;
        }
      }

      updateLayout();
    };
    const handleMeasure = () => updateLayout();
    scrollRoot?.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleMeasure);

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => updateLayout());
      resizeObserver.observe(root);
    }

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      scrollRoot?.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleMeasure);
    };
  }, [visibleTabs.length]);

  const currentTab = visibleTabs.find((tab) => tab.id === resolvedActiveTab) ?? visibleTabs[0] ?? null;
  const dockStyle = dockLayout
    ? ({ left: `${dockLayout.left}px`, right: `${dockLayout.right}px` } satisfies CSSProperties)
    : ({ left: "12px", right: "12px" } satisfies CSSProperties);
  const handleTabChange = (tabId: string) => {
    if (activeTabId === undefined) {
      setUncontrolledActiveTab(tabId);
    }
    onTabChange?.(tabId);
  };

  return (
    <section className={["settings-tabbed-detail", className].filter(Boolean).join(" ")} ref={rootRef}>
      {header}
      {leadingContent}

      {currentTab ? (
        <section className="panel task-detail-tabs-panel settings-detail-tabs-panel">
          <div className="task-detail-tabs__body settings-detail-tabs__body">
            <div
              className="settings-detail-tabpanel"
              id={`${dataRolePrefix}-tabpanel-${currentTab.id}`}
              data-role={`${dataRolePrefix}-tabpanel-wrapper-${currentTab.id}`}
              role="tabpanel"
              aria-labelledby={`${dataRolePrefix}-tab-${currentTab.id}`}
            >
              {currentTab.panel}
            </div>
          </div>
        </section>
      ) : null}

      {visibleTabs.length > 1 ? (
        <div
          className={dockShown
            ? "task-detail-tab-dock task-detail-tab-dock--persistent-settings"
            : "task-detail-tab-dock task-detail-tab-dock--persistent-settings task-detail-tab-dock--hidden"}
          data-role={`${dataRolePrefix}-tab-dock`}
          data-scroll-state={dockShown ? "visible" : "hidden"}
          style={dockStyle}
        >
          <label className="task-detail-section-select" data-role={`${dataRolePrefix}-section-select-mobile`}>
            <span className="task-detail-section-select__label">Section</span>
            <select
              className="select-input task-detail-section-select__control"
              data-role={`${dataRolePrefix}-section-select-control`}
              aria-label={`${ariaLabel} section`}
              value={currentTab.id}
              onChange={(event) => handleTabChange(event.target.value)}
            >
              {visibleTabs.map((tab) => (
                <option key={tab.id} value={tab.id}>{tab.label}</option>
              ))}
            </select>
          </label>
          <div className="task-detail-tabs task-detail-tabs--dock" role="tablist" aria-label={ariaLabel}>
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                className={currentTab.id === tab.id ? "task-detail-tab task-detail-tab--active" : "task-detail-tab"}
                data-role={`${dataRolePrefix}-tab-${tab.id}`}
                id={`${dataRolePrefix}-tab-${tab.id}`}
                role="tab"
                aria-selected={currentTab.id === tab.id}
                aria-controls={`${dataRolePrefix}-tabpanel-${tab.id}`}
                type="button"
                onClick={() => handleTabChange(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
