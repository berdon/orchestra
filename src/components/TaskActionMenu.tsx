import { useEffect, useRef, useState } from "react";

export interface TaskActionMenuAction {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  dataRole?: string;
}

interface TaskActionMenuProps {
  actions: TaskActionMenuAction[];
  menuLabel?: string;
}

export function TaskActionMenu({ actions, menuLabel = "Actions" }: TaskActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

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
    <div className="task-action-menu" ref={rootRef}>
      <div className="task-action-menu__desktop" data-role="task-action-menu-desktop">
        {actions.map((action) => (
          <button
            key={action.id}
            className={
              action.variant === "primary"
                ? "primary-button"
                : action.variant === "danger"
                  ? "secondary-button secondary-button--danger"
                  : "secondary-button"
            }
            data-role={action.dataRole}
            disabled={action.disabled}
            type="button"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div className="task-action-menu__mobile" data-role="task-action-menu-mobile">
        <button
          className="secondary-button task-action-menu__trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {menuLabel}
        </button>
        {open ? (
          <div className="task-action-menu__dropdown" role="menu">
            {actions.map((action) => (
              <button
                key={action.id}
                className={
                  action.variant === "primary"
                    ? "primary-button task-action-menu__dropdown-button"
                    : action.variant === "danger"
                      ? "secondary-button secondary-button--danger task-action-menu__dropdown-button"
                      : "secondary-button task-action-menu__dropdown-button"
                }
                data-role={action.dataRole}
                disabled={action.disabled}
                type="button"
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
