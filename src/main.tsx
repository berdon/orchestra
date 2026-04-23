import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import {
  OrchestraClientProvider,
  resolveInitialOrchestraClientBinding,
  type OrchestraClientBinding,
} from "./lib/orchestraClient";
import "./styles.css";

const rootElement = document.getElementById("root") as HTMLElement;
const root = ReactDOM.createRoot(rootElement);

function renderApp(binding: OrchestraClientBinding) {
  root.render(
    <React.StrictMode>
      <OrchestraClientProvider binding={binding}>
        <App />
      </OrchestraClientProvider>
    </React.StrictMode>,
  );
}

function renderBootstrapFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to initialize the Orchestra frontend.";
  root.render(
    <React.StrictMode>
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          background: "#08111b",
          color: "#f5f7fb",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: "42rem", width: "100%" }}>
          <h1 style={{ marginTop: 0 }}>Orchestra frontend bootstrap failed</h1>
          <p>The hosted-web client could not resolve its initial bootstrap/config/auth handshake.</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              padding: "1rem",
              borderRadius: "0.75rem",
              background: "rgba(255,255,255,0.08)",
            }}
          >
            {message}
          </pre>
        </div>
      </div>
    </React.StrictMode>,
  );
}

async function bootstrap() {
  try {
    renderApp(await resolveInitialOrchestraClientBinding());
  } catch (error) {
    console.error("[orchestra-client.bootstrap] Unable to initialize Orchestra frontend.", error);
    renderBootstrapFailure(error);
  }
}

void bootstrap();
