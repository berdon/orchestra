import { useEffect, useMemo, useRef, useState } from "react";

import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { ProjectSummary } from "../types";

interface ProjectSwitcherProps {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  unreadCountsByProject: Record<string, number>;
  hasUnreadOutsideActiveProject: boolean;
  collapsed: boolean;
  onSelectProject: (projectId: string) => void;
}

function getProjectMonogram(name: string | null | undefined) {
  const trimmed = name?.trim();
  if (!trimmed) {
    return "PR";
  }

  const segments = trimmed.split(/\s+/).filter(Boolean);
  const initials = segments.slice(0, 2).map((segment) => segment[0]?.toUpperCase() ?? "").join("");
  return initials || trimmed.slice(0, 2).toUpperCase();
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  unreadCountsByProject,
  hasUnreadOutsideActiveProject,
  collapsed,
  onSelectProject,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );

  const activeUnreadCount = activeProject?.id ? unreadCountsByProject[activeProject.id] ?? 0 : 0;
  const triggerBadge = activeUnreadCount > 0 ? String(activeUnreadCount) : hasUnreadOutsideActiveProject ? "•" : null;
  const getTooltipProps = useExplanatoryTooltipProps();
  const triggerName = activeProject?.name ?? "Select project";
  const triggerLabel = activeProject ? `Switch project: ${activeProject.name}` : "Select project";
  const triggerMonogram = getProjectMonogram(activeProject?.name);

  useEffect(() => {
    setOpen(false);
  }, [activeProjectId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="project-switcher" ref={rootRef} data-collapsed={collapsed ? "true" : "false"}>
      <span className="project-switcher__label">Project</span>
      <select
        className="project-switcher__native-select"
        data-role="project-switcher"
        aria-hidden="true"
        tabIndex={-1}
        value={activeProject?.id ?? ""}
        onChange={(event) => onSelectProject(event.target.value)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
      </select>

      <button
        className="project-switcher__button project-switcher__trigger"
        data-role="project-switcher-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        {...getTooltipProps("Switch the active project and refresh the app to that project's data.")}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="project-switcher__avatar" aria-hidden="true">{triggerMonogram}</span>
        <span className="project-switcher__trigger-body">
          <span className="project-switcher__trigger-label">{triggerName}</span>
        </span>
        {triggerBadge ? (
          <span className="status-badge status-badge--warning status-badge--compact project-switcher__badge" data-role="project-switcher-trigger-badge">
            {triggerBadge}
          </span>
        ) : null}
        <span className="project-switcher__chevron" aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="project-switcher__menu" data-role="project-switcher-menu" role="menu">
          {projects.map((project) => {
            const unreadCount = unreadCountsByProject[project.id] ?? 0;
            return (
              <button
                key={project.id}
                className={project.id === activeProject?.id ? "project-switcher__item project-switcher__item--active" : "project-switcher__item"}
                data-role={`project-switcher-option-${project.slug}`}
                type="button"
                role="menuitem"
                title={project.name}
                onClick={() => {
                  setOpen(false);
                  onSelectProject(project.id);
                }}
              >
                <span className="project-switcher__item-avatar" aria-hidden="true">{getProjectMonogram(project.name)}</span>
                <span className="project-switcher__item-label">{project.name}</span>
                {unreadCount > 0 ? (
                  <span className="status-badge status-badge--warning status-badge--compact project-switcher__badge">
                    {unreadCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
