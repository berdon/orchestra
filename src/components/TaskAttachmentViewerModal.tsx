import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useTaskAttachmentContent } from "../lib/orchestraData/tasks";
import { formatTaskAttachmentSize, getTaskAttachmentViewKind } from "../lib/taskAttachments";
import { detectCodeLanguage, highlightCode, shouldSyntaxHighlightText } from "../lib/syntaxHighlighting";
import type { TaskAttachment } from "../types";

interface Point {
  x: number;
  y: number;
}

interface TaskAttachmentViewerModalProps {
  attachment: TaskAttachment;
  onClose: () => void;
  onDownloadAttachment: (attachmentId: string) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function TaskAttachmentViewerModal({
  attachment,
  onClose,
  onDownloadAttachment,
}: TaskAttachmentViewerModalProps) {
  const getAttachmentContent = useTaskAttachmentContent();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragStartPointRef = useRef<Point | null>(null);
  const dragStartPanRef = useRef<Point>({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [imageMode, setImageMode] = useState<"fit" | "fill">("fit");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const viewKind = getTaskAttachmentViewKind(attachment.mediaType, attachment.fileName);
  const language = detectCodeLanguage(attachment.fileName, attachment.mediaType);
  const highlightedText = useMemo(() => {
    if (!textContent || !shouldSyntaxHighlightText(attachment.byteSize)) {
      return null;
    }
    return highlightCode(textContent, language);
  }, [attachment.byteSize, language, textContent]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTextContent(null);
    setImageSize(null);
    setObjectUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setImageMode("fit");

    void getAttachmentContent(attachment.id)
      .then(async (content) => {
        if (cancelled || !content) {
          return;
        }
        if (viewKind === "image") {
          const nextObjectUrl = URL.createObjectURL(content.blob);
          setObjectUrl(nextObjectUrl);
          return;
        }
        if (viewKind === "text") {
          setTextContent(await content.blob.text());
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to open attachment.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attachment.id, getAttachmentContent, viewKind]);

  useEffect(() => {
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  const imageScale = useMemo(() => {
    if (!imageSize || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return 1;
    }
    const fitScale = Math.min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height);
    const fillScale = Math.max(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height);
    const baseScale = imageMode === "fill" ? fillScale : fitScale;
    return baseScale * zoom;
  }, [imageMode, imageSize, viewportSize.height, viewportSize.width, zoom]);

  const panBounds = useMemo(() => {
    if (!imageSize) {
      return { x: 0, y: 0 };
    }
    const scaledWidth = imageSize.width * imageScale;
    const scaledHeight = imageSize.height * imageScale;
    return {
      x: Math.max(0, (scaledWidth - viewportSize.width) / 2),
      y: Math.max(0, (scaledHeight - viewportSize.height) / 2),
    };
  }, [imageScale, imageSize, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    setPan((current) => ({
      x: clamp(current.x, -panBounds.x, panBounds.x),
      y: clamp(current.y, -panBounds.y, panBounds.y),
    }));
  }, [panBounds.x, panBounds.y]);

  function updateZoom(nextZoom: number) {
    setZoom(clamp(Number(nextZoom.toFixed(2)), 0.5, 8));
  }

  function handleImagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!panBounds.x && !panBounds.y) {
      return;
    }
    dragPointerIdRef.current = event.pointerId;
    dragStartPointRef.current = { x: event.clientX, y: event.clientY };
    dragStartPanRef.current = pan;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleImagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId || !dragStartPointRef.current) {
      return;
    }
    const deltaX = event.clientX - dragStartPointRef.current.x;
    const deltaY = event.clientY - dragStartPointRef.current.y;
    setPan({
      x: clamp(dragStartPanRef.current.x + deltaX, -panBounds.x, panBounds.x),
      y: clamp(dragStartPanRef.current.y + deltaY, -panBounds.y, panBounds.y),
    });
  }

  function handleImagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current === event.pointerId) {
      dragPointerIdRef.current = null;
      dragStartPointRef.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function renderBody() {
    if (loading) {
      return <p className="muted-copy">Opening attachment…</p>;
    }
    if (error) {
      return <p className="supporting-copy">{error}</p>;
    }
    if (viewKind === "image" && objectUrl) {
      return (
        <>
          <div className="task-attachment-viewer__toolbar">
            <div className="button-row">
              <button className="secondary-button" data-role="task-attachment-viewer-zoom-out" type="button" onClick={() => updateZoom(zoom / 1.25)}>Zoom out</button>
              <button className="secondary-button" data-role="task-attachment-viewer-zoom-in" type="button" onClick={() => updateZoom(zoom * 1.25)}>Zoom in</button>
              <button className="secondary-button" data-role="task-attachment-viewer-reset" type="button" onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
                setImageMode("fit");
              }}>Reset</button>
            </div>
            <div className="button-row">
              <button className={`secondary-button task-attachment-viewer__mode-button${imageMode === "fit" ? " task-attachment-viewer__mode-button--active" : ""}`} data-role="task-attachment-viewer-fit" type="button" onClick={() => {
                setImageMode("fit");
                setPan({ x: 0, y: 0 });
              }}>Fit</button>
              <button className={`secondary-button task-attachment-viewer__mode-button${imageMode === "fill" ? " task-attachment-viewer__mode-button--active" : ""}`} data-role="task-attachment-viewer-fill" type="button" onClick={() => {
                setImageMode("fill");
                setPan({ x: 0, y: 0 });
              }}>Fill</button>
              <span className="status-badge status-badge--neutral" data-role="task-attachment-viewer-zoom-value">{Math.round(zoom * 100)}%</span>
            </div>
          </div>
          <div
            ref={viewportRef}
            className={`task-attachment-viewer__image-viewport${dragging ? " task-attachment-viewer__image-viewport--dragging" : ""}`}
            data-role="task-attachment-image-viewport"
            onWheel={(event) => {
              event.preventDefault();
              updateZoom(event.deltaY < 0 ? zoom * 1.1 : zoom / 1.1);
            }}
            onPointerDown={handleImagePointerDown}
            onPointerMove={handleImagePointerMove}
            onPointerUp={handleImagePointerUp}
            onPointerCancel={handleImagePointerUp}
          >
            <img
              alt={attachment.fileName}
              className="task-attachment-viewer__image"
              src={objectUrl}
              onLoad={(event) => {
                setImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${imageScale})` }}
            />
          </div>
        </>
      );
    }
    if (viewKind === "text") {
      return (
        <div className="task-attachment-viewer__text-shell" data-role="task-attachment-text-viewport">
          {highlightedText ? (
            <pre className="file-content-viewer__code task-attachment-viewer__text">
              <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlightedText }} />
            </pre>
          ) : (
            <pre className="task-attachment-viewer__text task-attachment-viewer__text--plain">{textContent ?? ""}</pre>
          )}
        </div>
      );
    }
    return <p className="supporting-copy">This attachment type cannot be viewed inline.</p>;
  }

  return (
    <div className="quick-chat-overlay task-attachment-viewer-overlay" data-role="task-attachment-viewer-overlay" onClick={onClose}>
      <section
        aria-labelledby="task-attachment-viewer-title"
        aria-modal="true"
        className="panel task-attachment-viewer"
        data-role="task-attachment-viewer"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="task-attachment-viewer__header">
          <div>
            <p className="eyebrow">Attachment viewer</p>
            <h3 id="task-attachment-viewer-title">{attachment.fileName}</h3>
            <p className="muted-copy">{attachment.mediaType} · {formatTaskAttachmentSize(attachment.byteSize)}</p>
          </div>
          <div className="button-row">
            <button className="secondary-button" data-role="task-attachment-viewer-download" type="button" onClick={() => onDownloadAttachment(attachment.id)}>Download</button>
            <button className="secondary-button" data-role="task-attachment-viewer-close" ref={closeButtonRef} type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="task-attachment-viewer__body">{renderBody()}</div>
      </section>
    </div>
  );
}
