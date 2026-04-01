import { useEffect, useRef, useState } from "react";
import { FitAddon, Terminal, init as initGhostty } from "../vendor/ghostty-web/ghostty-web";

import { getSessionRecord } from "../lib/tauri";
import { getAgentTerminalBuffer, resizeAgentTerminal, shutdownAgentTerminalSession, writeAgentTerminalInput } from "../lib/agents";
import type { SessionRecord } from "../types";

interface AgentTerminalWindowPageProps {
  sessionId: string;
}

export function AgentTerminalWindowPage({ sessionId }: AgentTerminalWindowPageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let unlisten: (() => void) | null = null;

    async function setup() {
      const nextSession = await getSessionRecord(sessionId);
      if (disposed) {
        return;
      }
      setSession(nextSession);

      const host = hostRef.current;
      if (!host) {
        return;
      }

      await initGhostty();
      if (disposed) {
        return;
      }

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        theme: {
          background: "#111318",
          foreground: "#e9ecf1",
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      fitAddon.fit();
      fitAddon.observeResize();

      term.onData((data) => {
        void writeAgentTerminalInput(sessionId, data);
      });
      term.onResize(({ cols, rows }) => {
        void resizeAgentTerminal(sessionId, cols, rows);
      });

      const initialBuffer = await getAgentTerminalBuffer(sessionId);
      if (!disposed && initialBuffer) {
        term.write(initialBuffer);
      }

      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const currentWindow = getCurrentWebviewWindow();
        unlisten = await currentWindow.listen<{ sessionId: string; data: string }>("agent-terminal-output", (event) => {
          if (event.payload.sessionId === sessionId) {
            term?.write(event.payload.data);
          }
        });
      }
    }

    setup().catch((nextError) => {
      if (!disposed) {
        setError(nextError instanceof Error ? nextError.message : "Unable to initialize embedded terminal.");
      }
    });

    const handleBeforeUnload = () => {
      void shutdownAgentTerminalSession(sessionId);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (unlisten) {
        unlisten();
      }
      term?.dispose();
      void shutdownAgentTerminalSession(sessionId);
    };
  }, [sessionId]);

  return (
    <main className="logs-window-shell agent-terminal-window">
      <header className="logs-window-header">
        <div>
          <p className="eyebrow">Embedded agent terminal</p>
          <h1>{session?.title ?? "Agent terminal"}</h1>
          <p className="muted-copy">Session {sessionId}</p>
        </div>
      </header>

      {error ? <p className="error-copy">{error}</p> : null}
      <section className="agent-terminal-window__surface">
        <div className="agent-terminal-window__terminal" data-role="agent-terminal-surface" ref={hostRef} />
      </section>
    </main>
  );
}
