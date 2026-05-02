import { useEffect, useRef, useState, type CSSProperties } from "react";

import { TaskActionMenu, type TaskActionMenuAction } from "./TaskActionMenu";

const FLOATING_HEADER_SCROLL_EPSILON = 2;
const FLOATING_HEADER_DIRECTION_THRESHOLD = 28;
const MOBILE_SUBNAV_MEDIA_QUERY = "(max-width: 900px)";

interface SettingsMobileSubnavOption {
  id: string;
  label: string;
  disabled?: boolean;
}

interface FloatingHeaderLayout {
  left: number;
  right: number;
  top: number;
}

interface SettingsMobileSubnavHeaderProps {
  dataRolePrefix: string;
  selectLabel?: string | null;
  ariaLabel: string;
  value: string | null;
  emptyOptionLabel?: string;
  options: SettingsMobileSubnavOption[];
  onChange: (value: string) => void;
  actions?: TaskActionMenuAction[];
  actionMenuLabel?: string;
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

export function SettingsMobileSubnavHeader({
  dataRolePrefix,
  selectLabel = "Selection",
  ariaLabel,
  value,
  emptyOptionLabel,
  options,
  onChange,
  actions = [],
  actionMenuLabel = "Actions",
}: SettingsMobileSubnavHeaderProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_SUBNAV_MEDIA_QUERY).matches);
  const [floatingLayout, setFloatingLayout] = useState<FloatingHeaderLayout | null>(null);
  const [floatingHeaderEligible, setFloatingHeaderEligible] = useState(false);
  const [floatingHeaderShown, setFloatingHeaderShown] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_SUBNAV_MEDIA_QUERY);
    const handleChange = () => setIsMobileViewport(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setFloatingLayout(null);
      setFloatingHeaderEligible(false);
      setFloatingHeaderShown(false);
      return;
    }
    const shell = shellRef.current;
    const sentinel = sentinelRef.current;
    if (!shell || !sentinel || typeof window === "undefined") {
      setFloatingLayout(null);
      setFloatingHeaderEligible(false);
      setFloatingHeaderShown(false);
      return;
    }

    const contentRoot = shell.closest(".content") as HTMLElement | null;
    const scrollRoot = findScrollRoot(shell) ?? contentRoot;
    const layoutRoot = shell.nextElementSibling instanceof HTMLElement ? shell.nextElementSibling : shell;
    const mobileTopbar = document.querySelector('[data-role="mobile-topbar"]') as HTMLElement | null;
    let frameId: number | null = null;
    const getScrollPosition = () => Math.max(scrollRoot?.scrollTop ?? 0, window.scrollY, shell.ownerDocument.documentElement.scrollTop);
    let lastScrollPosition = getScrollPosition();
    let accumulatedDirection: "up" | "down" | null = null;
    let accumulatedDistance = 0;
    let pendingScrollIntent: "up" | "down" | null = null;

    const updateFloatingChrome = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        const shellRect = shell.getBoundingClientRect();
        const layoutRect = layoutRoot.getBoundingClientRect();
        const contentRect = contentRoot?.getBoundingClientRect() ?? null;
        const topbarRect = mobileTopbar?.getBoundingClientRect() ?? null;
        const pinnedTop = Math.max(contentRect?.top ?? 0, topbarRect?.bottom ?? 0, 0) + 10;
        const nextLayout = shellRect.width > 0 && layoutRect.bottom > pinnedTop + 72
          ? {
              left: Math.max(shellRect.left, 12),
              right: Math.max(window.innerWidth - shellRect.right, 12),
              top: pinnedTop,
            }
          : null;
        const scrollPosition = getScrollPosition();
        const nextEligible = shellRect.top <= pinnedTop + 4;

        setFloatingLayout((current) => {
          if (!nextLayout && !current) {
            return current;
          }
          if (
            current
            && nextLayout
            && current.left === nextLayout.left
            && current.right === nextLayout.right
            && current.top === nextLayout.top
          ) {
            return current;
          }
          return nextLayout;
        });

        if (!nextLayout || !nextEligible) {
          accumulatedDirection = null;
          accumulatedDistance = 0;
          pendingScrollIntent = null;
          lastScrollPosition = scrollPosition;
          setFloatingHeaderEligible((current) => (current ? false : current));
          setFloatingHeaderShown((current) => (current ? false : current));
          return;
        }

        setFloatingHeaderEligible((current) => (current === nextEligible ? current : nextEligible));

        if (pendingScrollIntent) {
          const nextShown = pendingScrollIntent === "up";
          pendingScrollIntent = null;
          setFloatingHeaderShown((current) => (current === nextShown ? current : nextShown));
        }
      });
    };

    updateFloatingChrome();
    const handleScroll = () => {
      const scrollPosition = getScrollPosition();
      const delta = scrollPosition - lastScrollPosition;
      lastScrollPosition = scrollPosition;

      if (Math.abs(delta) >= FLOATING_HEADER_SCROLL_EPSILON) {
        const nextDirection = delta > 0 ? "down" : "up";
        if (accumulatedDirection !== nextDirection) {
          accumulatedDirection = nextDirection;
          accumulatedDistance = Math.abs(delta);
        } else {
          accumulatedDistance += Math.abs(delta);
        }

        if (accumulatedDistance >= FLOATING_HEADER_DIRECTION_THRESHOLD) {
          pendingScrollIntent = nextDirection;
          accumulatedDistance = 0;
        }
      }

      updateFloatingChrome();
    };
    const handleMeasure = () => updateFloatingChrome();
    scrollRoot?.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      scrollRoot?.removeEventListener("scroll", handleScroll);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleMeasure);
    };
  }, [isMobileViewport, options.length, value]);

  const floatingStyle = floatingLayout
    ? ({
        left: `${floatingLayout.left}px`,
        right: `${floatingLayout.right}px`,
        top: `${floatingLayout.top}px`,
      } satisfies CSSProperties)
    : undefined;

  const renderPicker = (floating: boolean) => (
    <div className="settings-mobile-subnav__picker">
      {selectLabel ? <span className="settings-mobile-subnav__label">{selectLabel}</span> : null}
      <select
        className="select-input settings-mobile-subnav__control"
        data-role={floating ? `${dataRolePrefix}-mobile-subnav-select-control-floating` : `${dataRolePrefix}-mobile-subnav-select-control`}
        aria-label={ariaLabel}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {emptyOptionLabel ? <option value="">{emptyOptionLabel}</option> : null}
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </div>
  );

  const renderHeader = () => (
    <div className="settings-mobile-subnav" data-role={`${dataRolePrefix}-mobile-subnav`}>
      {renderPicker(false)}
      {actions.length ? (
        <div className="settings-mobile-subnav__actions" data-role={`${dataRolePrefix}-mobile-subnav-actions`}>
          <TaskActionMenu
            actions={actions}
            menuLabel={actionMenuLabel}
            mobileTriggerVariant="icon"
            mobileTriggerIcon="☰"
            mobileTriggerAriaLabel={actionMenuLabel}
            mobileTriggerDataRole={`${dataRolePrefix}-mobile-subnav-menu-trigger`}
          />
        </div>
      ) : null}
    </div>
  );

  if (!isMobileViewport) {
    return null;
  }

  return (
    <div className="settings-mobile-subnav-shell" ref={shellRef} data-role={`${dataRolePrefix}-mobile-subnav-shell`}>
      {renderHeader()}
      <div className="settings-mobile-subnav__sentinel" ref={sentinelRef} aria-hidden="true" />
      {floatingLayout ? (
        <div
          className={floatingHeaderEligible && !floatingHeaderShown
            ? "settings-mobile-subnav-floating-shell settings-mobile-subnav-floating-shell--hidden"
            : "settings-mobile-subnav-floating-shell"}
          data-role={`${dataRolePrefix}-mobile-subnav-floating-shell`}
          data-scroll-state={floatingHeaderEligible && floatingHeaderShown ? "visible" : "hidden"}
          style={floatingStyle}
        >
          <div className="settings-mobile-subnav settings-mobile-subnav--floating" data-role={`${dataRolePrefix}-mobile-subnav-floating`}>
            {renderPicker(true)}
            {actions.length ? (
              <div className="settings-mobile-subnav__actions" data-role={`${dataRolePrefix}-mobile-subnav-actions-floating`}>
                <TaskActionMenu
                  actions={actions}
                  menuLabel={actionMenuLabel}
                  mobileTriggerVariant="icon"
                  mobileTriggerIcon="☰"
                  mobileTriggerAriaLabel={actionMenuLabel}
                  mobileTriggerDataRole={`${dataRolePrefix}-mobile-subnav-menu-trigger-floating`}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
