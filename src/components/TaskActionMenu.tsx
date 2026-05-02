import { useEffect, useRef, useState, type ReactNode } from "react";

import { useExplanatoryTooltipProps } from "../lib/tooltips";

export interface TaskActionMenuAction {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  dataRole?: string;
  tooltip?: string;
}

interface TaskActionMenuProps {
  actions: TaskActionMenuAction[];
  menuLabel?: string;
  pendingActionId?: string | null;
  className?: string;
  mobileTriggerVariant?: "label" | "icon";
  mobileTriggerIcon?: ReactNode;
  mobileTriggerAriaLabel?: string;
  mobileTriggerDataRole?: string;
}

export function TaskActionMenu({
  actions,
  menuLabel = "Actions",
  pendingActionId = null,
  className,
  mobileTriggerVariant = "label",
  mobileTriggerIcon = "☰",
  mobileTriggerAriaLabel,
  mobileTriggerDataRole,
}: TaskActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  return (
    <div className={["task-action-menu", className].filter(Boolean).join(" ")} ref={rootRef}>
      <div className="task-action-menu__desktop" data-role="task-action-menu-desktop">
        {actions.map((action) => (
          <button
            key={action.id}
            className={
              `${
                action.variant === "primary"
                  ? "primary-button"
                  : action.variant === "danger"
                    ? "secondary-button secondary-button--danger"
                    : "secondary-button"
              }${pendingActionId === action.id ? " task-action-button--pending" : ""}`
            }
            data-role={action.dataRole}
            disabled={Boolean(pendingActionId) || action.disabled}
            type="button"
            {...getTooltipProps(action.tooltip)}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div className="task-action-menu__mobile" data-role="task-action-menu-mobile">
        <button
          className={mobileTriggerVariant === "icon" ? "secondary-button task-action-menu__trigger task-action-menu__trigger--icon" : "secondary-button task-action-menu__trigger"}
          data-role={mobileTriggerDataRole}
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={mobileTriggerVariant === "icon" ? (mobileTriggerAriaLabel ?? menuLabel) : undefined}
          title={mobileTriggerVariant === "icon" ? (mobileTriggerAriaLabel ?? menuLabel) : undefined}
        >
          {mobileTriggerVariant === "icon" ? <span aria-hidden="true">{mobileTriggerIcon}</span> : menuLabel}
        </button>
        {open ? (
          <div className="task-action-menu__dropdown" role="menu">
            {actions.map((action) => (
              <button
                key={action.id}
                className={
                  `${
                    action.variant === "primary"
                      ? "primary-button task-action-menu__dropdown-button"
                      : action.variant === "danger"
                        ? "secondary-button secondary-button--danger task-action-menu__dropdown-button"
                        : "secondary-button task-action-menu__dropdown-button"
                  }${pendingActionId === action.id ? " task-action-button--pending" : ""}`
                }
                data-role={action.dataRole}
                disabled={Boolean(pendingActionId) || action.disabled}
                type="button"
                {...getTooltipProps(action.tooltip)}
                onClick={() => {
                  setOpen(false);
                  action.onClick();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
