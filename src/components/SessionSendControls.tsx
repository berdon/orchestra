import { useEffect, useRef, useState } from "react";

import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { SessionSendMode } from "../types";

export function formatSessionDefaultSendSummary(busy: boolean) {
  return busy
    ? "Default: queue behind current work · Options: Queue, Interrupt"
    : "Default: send now if idle · Options: Queue, Interrupt";
}

function formatDefaultSendDescription(busy: boolean) {
  return busy
    ? "Default Send queues behind current work while the session is active."
    : "Default Send starts immediately because the session is idle.";
}

function formatSendOptionDescription(mode: SessionSendMode, busy: boolean) {
  switch (mode) {
    case "queue":
      return busy
        ? "Wait until current work finishes, then deliver this as a follow-up."
        : "Send immediately because the session is idle.";
    case "interrupt":
      return busy
        ? "Steer next after the current turn, ahead of queued follow-ups."
        : "Send immediately because the session is idle.";
    default:
      return formatDefaultSendDescription(busy);
  }
}

interface SessionSendControlsProps {
  busy: boolean;
  disabled?: boolean;
  onSendWithMode: (mode: SessionSendMode) => void;
  sendButtonDataRole: string;
  optionsTriggerDataRole: string;
  optionsMenuDataRole: string;
  queueOptionDataRole: string;
  interruptOptionDataRole: string;
  sendButtonLabel: string;
  optionsLabel?: string;
}

export function SessionSendControls({
  busy,
  disabled = false,
  onSendWithMode,
  sendButtonDataRole,
  optionsTriggerDataRole,
  optionsMenuDataRole,
  queueOptionDataRole,
  interruptOptionDataRole,
  sendButtonLabel,
  optionsLabel = "Send options",
}: SessionSendControlsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="session-send-menu" ref={rootRef}>
      <div className="session-send-menu__group">
        <button
          className="primary-button"
          data-role={sendButtonDataRole}
          type="submit"
          aria-label={sendButtonLabel}
          title={sendButtonLabel}
          disabled={disabled}
          {...getTooltipProps(formatDefaultSendDescription(busy))}
          onClick={() => setOpen(false)}
        >
          ↗
        </button>
        <button
          className="secondary-button session-actions-menu__trigger session-send-menu__trigger"
          data-role={optionsTriggerDataRole}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={optionsLabel}
          title={optionsLabel}
          disabled={disabled}
          {...getTooltipProps("Choose Queue or Interrupt for a one-off send.")}
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>
      {open ? (
        <div className="session-actions-menu__dropdown session-send-menu__dropdown" data-role={optionsMenuDataRole} role="menu">
          <p className="session-send-menu__header muted-copy">{formatDefaultSendDescription(busy)}</p>
          <button
            className="secondary-button session-actions-menu__item session-send-menu__item"
            data-role={queueOptionDataRole}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSendWithMode("queue");
            }}
          >
            <span className="session-send-menu__item-label">Queue</span>
            <span className="session-send-menu__item-description">{formatSendOptionDescription("queue", busy)}</span>
          </button>
          <button
            className="secondary-button session-actions-menu__item session-send-menu__item"
            data-role={interruptOptionDataRole}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSendWithMode("interrupt");
            }}
          >
            <span className="session-send-menu__item-label">Interrupt</span>
            <span className="session-send-menu__item-description">{formatSendOptionDescription("interrupt", busy)}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
