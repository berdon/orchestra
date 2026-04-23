import { useEffect, useRef, useState } from "react";
import { FitAddon, Terminal, init as initGhostty } from "../vendor/ghostty-web/ghostty-web";

import { useOrchestraClient } from "../lib/orchestraClient";

interface AgentTerminalWindowPageProps {
  sessionId: string;
}

export function AgentTerminalWindowPage({ sessionId }: AgentTerminalWindowPageProps) {
  const orchestraClient = useOrchestraClient();
  const agentTerminal = orchestraClient.shell?.agentTerminal;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!agentTerminal) {
      setReady(false);
      setError("Embedded terminal controls are unavailable in this client.");
      return;
    }

    const terminalExtension = agentTerminal;
    let disposed = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let pollIntervalId: number | null = null;
    let lastBufferLength = 0;

    async function setup() {
      const host = hostRef.current;
      if (!host) {
        return;
      }

      try {
        await initGhostty();
      } catch (error) {
        throw new Error(`ghostty init failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (disposed) {
        return;
      }

      try {
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
        if (typeof fitAddon.observeResize === "function") {
          fitAddon.observeResize();
        }
      } catch (error) {
        throw new Error(`ghostty terminal mount failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        term.onData((data: string) => {
          void terminalExtension.writeInput(sessionId, data);
        });
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          void terminalExtension.resize(sessionId, cols, rows);
        });
      } catch (error) {
        throw new Error(`ghostty event hookup failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const initialBuffer = await terminalExtension.getBuffer(sessionId);
        if (!disposed && initialBuffer) {
          term.write(initialBuffer);
          lastBufferLength = initialBuffer.length;
        }
      } catch (error) {
        throw new Error(`terminal buffer load failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      pollIntervalId = window.setInterval(() => {
        void terminalExtension.getBuffer(sessionId)
          .then((buffer) => {
            if (disposed || !term) {
              return;
            }
            if (buffer.length <= lastBufferLength) {
              return;
            }
            term.write(buffer.slice(lastBufferLength));
            lastBufferLength = buffer.length;
          })
          .catch(() => {
            // Ignore transient polling failures while the terminal tears down.
          });
      }, 500);

      if (!disposed) {
        setReady(true);
      }
    }

    setup().catch((nextError) => {
      if (!disposed) {
        setReady(false);
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        console.error("Agent terminal init failed", nextError);
        setError(message || "Unable to initialize embedded terminal.");
      }
    });

    const handleBeforeUnload = () => {
      void terminalExtension.shutdown(sessionId);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (pollIntervalId !== null) {
        window.clearInterval(pollIntervalId);
      }
      term?.dispose();
      void terminalExtension.shutdown(sessionId);
    };
  }, [agentTerminal, sessionId]);

  return (
    <main
      className="agent-terminal-window"
      data-role="agent-terminal-window"
      data-terminal-ready={ready ? "true" : "false"}
      data-session-id={sessionId}
    >
      <div className="agent-terminal-window__surface">
        <div className="agent-terminal-window__terminal" data-role="agent-terminal-surface" ref={hostRef} />
        {error ? (
          <div className="agent-terminal-window__error" data-role="agent-terminal-error">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}
