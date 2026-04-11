import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

interface ResizableSidebarLayoutProps {
  className: string;
  storageKey: string;
  navigation: ReactNode;
  detail: ReactNode;
  navigationClassName: string;
  detailClassName: string;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
}

function readStoredWidth(storageKey: string, defaultWidth: number, minWidth: number, maxWidth: number) {
  const raw = window.localStorage.getItem(storageKey);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return defaultWidth;
  }
  return Math.max(minWidth, Math.min(maxWidth, parsed));
}

export function ResizableSidebarLayout({
  className,
  storageKey,
  navigation,
  detail,
  navigationClassName,
  detailClassName,
  minWidth = 220,
  maxWidth = 420,
  defaultWidth = 248,
}: ResizableSidebarLayoutProps) {
  const [navWidth, setNavWidth] = useState(() => readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth));
  const dragStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(navWidth));
  }, [navWidth, storageKey]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      const nextWidth = Math.max(minWidth, Math.min(maxWidth, Math.round(dragState.startWidth + (event.clientX - dragState.startX))));
      setNavWidth(nextWidth);
      window.localStorage.setItem(storageKey, String(nextWidth));
    }

    function finishDrag(pointerId: number) {
      if (dragStateRef.current?.pointerId === pointerId) {
        dragStateRef.current = null;
      }
    }

    function handlePointerUp(event: PointerEvent) {
      finishDrag(event.pointerId);
    }

    function handlePointerCancel(event: PointerEvent) {
      finishDrag(event.pointerId);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [maxWidth, minWidth, storageKey]);

  const style = useMemo(() => ({
    "--secondary-nav-width": `${navWidth}px`,
  }) as CSSProperties, [navWidth]);

  return (
    <section className={`${className} resizable-sidebar-layout`} style={style}>
      <aside className={navigationClassName}>
        {navigation}
      </aside>
      <div
        className="secondary-nav-resize-handle"
        data-role="secondary-nav-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize navigation"
        onDoubleClick={() => setNavWidth(defaultWidth)}
        onPointerDown={(event) => {
          dragStateRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: navWidth,
          };
          (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
        }}
      >
        <span className="secondary-nav-resize-handle__bar" aria-hidden="true" />
      </div>
      <section className={detailClassName}>
        {detail}
      </section>
    </section>
  );
}
