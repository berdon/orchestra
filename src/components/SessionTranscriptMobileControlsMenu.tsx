import { useEffect, useRef } from "react";

import { useExplanatoryTooltipProps } from "../lib/tooltips";

interface SessionTranscriptMobileControlsMenuProps {
  open: boolean;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  autoScrollEnabled: boolean;
  wrapEnabled: boolean;
  onToggleAutoScroll: () => void;
  onToggleWrap: () => void;
  onOpenTask?: () => void;
  triggerDataRole?: string;
  menuDataRole?: string;
}

export function SessionTranscriptMobileControlsMenu({
  open,
  disabled = false,
  onOpenChange,
  autoScrollEnabled,
  wrapEnabled,
  onToggleAutoScroll,
  onToggleWrap,
  onOpenTask,
  triggerDataRole = "session-mobile-transcript-controls-trigger",
  menuDataRole = "session-mobile-transcript-controls-menu",
}: SessionTranscriptMobileControlsMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  useEffect(() => {
    if (disabled && open) {
      onOpenChange(false);
    }
  }, [disabled, onOpenChange, open]);

  return (
    <div className="page-mobile-switcher__menu" ref={rootRef}>
      <button
        className="secondary-button page-mobile-switcher__menu-trigger"
        type="button"
        data-role={triggerDataRole}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Transcript controls"
        title="Transcript controls"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {open ? (
        <div className="page-mobile-switcher__menu-dropdown" data-role={menuDataRole} role="menu">
          {onOpenTask ? (
            <button
              className="secondary-button page-mobile-switcher__menu-item"
              data-role="session-mobile-open-task"
              type="button"
              role="menuitem"
              {...getTooltipProps("Open the active task details for this session.")}
              onClick={() => {
                onOpenChange(false);
                onOpenTask();
              }}
            >
              <span aria-hidden="true">↗</span>
              <span>Open task</span>
            </button>
          ) : null}
          <button
            className="secondary-button page-mobile-switcher__menu-item"
            data-role="session-mobile-auto-scroll-toggle"
            data-auto-scroll-mode={autoScrollEnabled ? "on" : "off"}
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoScrollEnabled}
            aria-label={autoScrollEnabled ? "Disable auto-scroll" : "Enable auto-scroll and jump to latest"}
            {...getTooltipProps(
              autoScrollEnabled
                ? "Follow the live transcript and keep the latest output in view."
                : "Pause transcript following so you can inspect earlier output.",
            )}
            onClick={() => {
              onOpenChange(false);
              onToggleAutoScroll();
            }}
          >
            <span aria-hidden="true">{autoScrollEnabled ? "↓" : "⏸"}</span>
            <span>{autoScrollEnabled ? "Auto-scroll on" : "Auto-scroll off"}</span>
          </button>
          <button
            className="secondary-button page-mobile-switcher__menu-item"
            data-role="session-mobile-wrap-toggle"
            data-wrap-mode={wrapEnabled ? "wrap" : "nowrap"}
            type="button"
            role="menuitemcheckbox"
            aria-checked={wrapEnabled}
            aria-label={wrapEnabled ? "Disable transcript line wrapping" : "Enable transcript line wrapping"}
            {...getTooltipProps(
              wrapEnabled
                ? "Wrap long transcript lines so they stay inside the panel."
                : "Show each transcript line without wrapping.",
            )}
            onClick={() => {
              onOpenChange(false);
              onToggleWrap();
            }}
          >
            <span aria-hidden="true">{wrapEnabled ? "↩" : "↔"}</span>
            <span>{wrapEnabled ? "Wrap" : "No wrap"}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
